# 26 - Global Search

> **Status:** Backend shipped — `GET /api/search` works out of the box on SQLite and PostgreSQL with
> the built-in database full-text provider, behind an open `SearchProvider` contract. This document is
> the user-facing feature guide: what it is, how to configure and query it, and when to reach for a
> plugin backend. The dashboard search panel and the SDK search resources shipped in v0.8.13; both
> build on the REST endpoint documented here and in
> [06 - API Specification](./06-api-specification.md).

## 26.1 What it is

**Global message search** finds messages across **all sessions** through a single endpoint,
`GET /api/search`. Instead of looping over `GET /api/sessions/:id/messages/...` per session and
filtering client-side, a caller sends one query — a free-text term plus optional structural filters
(session, chat, direction, type, sender, date range) — and gets a ranked, paginated hit list with
highlighted snippets. It is the search substrate the dashboard search panel and external integrations
build on.

Search is **on by default** and works with zero external dependencies: the built-in provider is
DB-native (PostgreSQL `tsvector`/`GIN`, SQLite `FTS5`), so there is no separate search service to
provision, run, or keep in sync. Set `SEARCH_ENABLED=false` to remove the route and module entirely.

## 26.2 The provider model

Search is backed by an open `SearchProvider` contract, not a hardcoded query path:

```ts
interface SearchProvider {
  readonly id: string; // e.g. 'builtin-fts'
  readonly label: string; // human label for dashboard/config
  search(query: SearchQuery): Promise<SearchResults>;
  health(): Promise<SearchHealth>; // provider liveness; not yet surfaced on any route
}
```

A registry holds the set of registered providers and the currently active one. Core registers
`builtin-fts` at bootstrap; a marketplace plugin registers itself the same way and, under the default
`SEARCH_PROVIDER=auto`, supersedes the built-in when it is enabled (see §26.5). When no provider is
registered, the route returns `501` (never crashes boot). The active provider answers every `/search`
call, so swapping backends is a config change, not a code change. Importantly, **indexing is not part
of the contract** — each provider owns how its index stays current (the built-in is DB-level; a plugin
is hook-driven, see §26.7).

## 26.3 The built-in DB full-text default

The zero-dependency default (`id: builtin-fts`) uses the database's own full-text engine, so the index
is maintained by the DB on every INSERT/UPDATE/DELETE with no application code in the write path:

- **PostgreSQL (12+)** — a STORED generated `tsvector` column (`body_ts`, config `'simple'`) on
  `messages` with a `GIN` index over it. The column is auto-maintained by Postgres, so sends,
  receives, edits, and deletes stay in sync with zero app logic. Ranking uses `ts_rank`; snippets use
  `ts_headline`.
- **SQLite (FTS5)** — an `FTS5` external-content virtual table (`messages_fts`) keyed on the implicit
  `rowid`, kept in sync by AFTER INSERT/UPDATE/DELETE triggers and backfilled once at migration time.
  Ranking uses FTS5 `rank`; snippets use `snippet()`.

On Postgres the search term goes through `websearch_to_tsquery`, so quoted phrases, `OR`, and
`-`exclusion behave as Postgres defines them. On SQLite the term is matched **literally**: every
whitespace-separated token is quoted (internal quotes doubled) before it reaches FTS5 `MATCH`, so FTS5
query grammar (phrases, bare `OR`/`AND`/`NOT`/`NEAR`, parentheses, `*`) is neutralised and inputs such
as phone numbers or `…@lid` ids match as plain text; multiple tokens are still implicitly ANDed.
Snippets are emitted with `<mark>`/`</mark>` highlight markers on both dialects so the
`SearchHit.snippet` contract is dialect-agnostic. The body text inside the snippet is **not**
HTML-escaped: split on the literal `<mark>`/`</mark>` markers and render each segment as text (the
dashboard does this with `renderHighlightedSnippet` in `dashboard/src/utils/search-highlight.ts`), and
never assign the raw snippet to `innerHTML`.

### Match modes

The `match` query parameter picks how `q` matches a message body. Each mode has its own DB-maintained
index, so both are index lookups, never table scans:

| `match`          | Matches                                                                                                      | Index                                                                                                                                    | Ranking                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `word` (default) | whole words, as described above                                                                              | `body_ts` (Postgres) / `messages_fts` (SQLite)                                                                                           | `ts_rank` / FTS5 `rank`, over every match                  |
| `contains`       | any part of a word of 3+ characters, ignoring case and accents (`voic` finds "Invoice", `cafe` finds "Café") | a `pg_trgm` GIN index on `openwa_unaccent(body)` (Postgres) / an FTS5 `trigram` table with `remove_diacritics`, `messages_trgm` (SQLite) | match quality, over the 1,000 most recently stored matches |

`contains` finds everything `word` finds, plus partial words. Every whitespace-separated term must
appear, as with `word`; a repeated term (also one that differs only in case or accents) runs once. A
trigram index cannot look up a term shorter than three characters, so such a term (`id`, `pm`) only
narrows what a longer term found, and a query made of short terms alone answers `400`. The query
grammar of `word` mode (quoted phrases, `OR`, `-` on Postgres) does not apply: every term, `%` and `_`
included, matches literally.

**Ranking runs in two phases.** Ranking every match in SQL costs time in proportion to the number of
matches: measured on 1M messages with a term found in 200k of them, about 100 ms on SQLite (where that
time blocks the event loop every session shares) and 1.6 s on Postgres. So `contains` bounds the work:

1. The database returns at most **1,000 candidates**: the most recently stored messages that contain
   every term, newest first. Both dialects answer that order from an index and stop at 1,000, however
   many messages match. SQLite reads its trigram index in insertion order; Postgres walks the
   `idx_messages_created_at_id` b-tree backward for a common term, or reads the few matches of a rare
   one from the GIN index.
2. The application ranks the candidates and pages them: each term scores **3** as a whole word, **2**
   at the start of a word and **1** inside a word (compared without case or accents), the hit's `score`
   is the sum over the terms, and ties go to the newest message, then to `messageId`. The same code
   ranks both dialects, so they return the same order.

Both phases together take about 2 ms on SQLite and 10 to 20 ms on Postgres at that size. The trade-off is that relevance orders the window, not the whole history: `total` is at most
1,000 in this mode, and pages past it are empty. Reach older matches by narrowing the query (more
terms, `chatId`, `dateTo`). Because a score reads only its own message, it is returned to scoped keys
as well (unlike the SQLite `word` score, see below).

A `contains` snippet is built by the application rather than the database (FTS5's `snippet()` counts
its window in trigrams, and Postgres has no headline function for a substring), so both dialects return
the same text, under the same `<mark>` contract and the same "not HTML-escaped" rule.

**Requirements.** On SQLite, `contains` needs FTS5 and SQLite 3.45+ (the first with `remove_diacritics`
for the trigram tokenizer); the bundled `better-sqlite3` ships both. On Postgres it needs the
`pg_trgm` and `unaccent` extensions, which the migration creates when the database role may (both are
trusted extensions from PostgreSQL 13, so a database owner can). When it may not, the migration skips
them without failing the boot, only `match=contains` answers `501` (with the `CREATE EXTENSION`
statements to run), and `match=word` keeps working; once an operator installs the extensions, the next
boot builds the wrapper function and the indexes.

## 26.4 Dual-database switching safety

Search is designed to work identically on SQLite and PostgreSQL and to survive repeated switching
between them (e.g. developing on SQLite, deploying on Postgres, exporting a SQLite DB and importing
it into Postgres). Concretely:

- **Idempotent, dialect-branched migration.** The FTS migration (`1782400000000-AddMessagesFts`)
  branches on the active dialect and uses `IF NOT EXISTS` / `IF NOT` guards, so `migration:run` is
  safe to re-run on either backend. It does the one-time backfill for existing rows on first apply.
- **The provider picks its dialect per `DataSource`.** The built-in provider inspects
  `dataSource.options.type` on every query and builds the correct SQL (`?` vs `$n` placeholders,
  `messages_fts MATCH` vs `body_ts @@`, the right snippet function), so the same code path serves both
  backends without per-dialect configuration.
- **Graceful SQLite fallback.** A SQLite build **without** FTS5 compiled in does **not** crash boot:
  the migration probes `sqlite_compileoption_used('ENABLE_FTS5')` and skips, leaving no FTS schema; the
  provider detects the absent `messages_fts` table and the route returns `501` cleanly. (The bundled
  Docker image and the official Node builds include FTS5, so this only affects a custom-compiled
  SQLite.)
- **Export/import round-trip.** Because the index is a derived, DB-maintained structure (not a
  separate data store), an OpenWA export/import — which clears the `messages` table and re-inserts —
  leaves FTS correct on both dialects: Postgres regenerates the `body_ts` column from the re-inserted
  rows, and SQLite's triggers repopulate `messages_fts` on the re-inserts. No separate search reindex
  step is needed after a restore or a dialect migration. This is covered by the dual-DB test suite.

## 26.5 Configuration

All search configuration lives in the environment (`.env` / Compose):

| Variable           | Default        | Meaning                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEARCH_ENABLED`   | `true` (unset) | Set to `false` to remove the `/search` route and the entire search module — zero footprint, no DI wiring. The migration still runs (so the index is ready if you re-enable).                                                                                                                                                                                                  |
| `SEARCH_PROVIDER`  | `auto`         | `auto` selects the built-in provider at runtime and lets an enabled plugin provider supersede it; `builtin-fts` pins the built-in explicitly; `none` leaves the registry empty — the module and the route stay mounted, but with no active provider `/api/search` answers `501`. Those three are the only accepted values — anything else (including a plugin id) fails boot. |
| `SEARCH_LIMIT_MAX` | `100`          | Hard cap applied to the `limit` query parameter, so a caller cannot request an unbounded result set.                                                                                                                                                                                                                                                                          |

### The opt-out footprint note

Setting `SEARCH_ENABLED=false` removes the **route and module**, but the **full-text index itself is
maintained per-write regardless**, because the index is DB-level (generated column / triggers), not
application-level. This is deliberate and by design: the index is a cheap derived structure maintained
in-process by the database on the same write that persists the message, so there is no extra network
hop, no separate service, and no double-write. The cost is negligible (a `tsvector` generate on
Postgres, a trigger-fire on SQLite — both in-process, both on columns already being written). If you
want to drop the index entirely, run the migration `down` against the data connection.

> **Dev note — `DATABASE_SYNCHRONIZE=true`.** With synchronize on (a common zero-config dev setting),
> TypeORM creates the `messages` table from the entity but never runs migrations, so the FTS schema
> would be missing. The built-in provider therefore re-applies the migration's idempotent DDL at boot
> (including the one-time SQLite backfill), so `/search` works on a fresh synchronize-based box with no
> manual `npm run migration:run` step. On migrations-based deployments the same DDL is a set of no-ops.
>
> **Postgres caveat — `DATABASE_TYPE=postgres` with `DATABASE_SYNCHRONIZE=true` is rejected at boot.**
> The Postgres data connection hardcodes `migrationsRun=true` (unlike SQLite, where it is
> `!synchronize`), so on Postgres both would run every boot: the migration adds the generated `body_ts`
> column, then `synchronize` immediately drops it (the `Message` entity does not declare `body_ts`),
> leaving `/search` returning `501` on every restart. Env validation refuses the boot with an explicit
> error instead. Use migrations (`DATABASE_SYNCHRONIZE=false`, the prod default) for Postgres. SQLite is
> unaffected (its `migrationsRun` is `!synchronize`).

## 26.6 The HTTP endpoint

See [06 - API Specification §6.4.12](./06-api-specification.md) for the full param/response reference.
In brief:

```
GET /api/search?q=<term>&match=<word|contains>&sessionId=<id>&chatId=<id>&direction=<incoming|outgoing>
            &type=<type>&from=<sender>&dateFrom=<ms>&dateTo=<ms>&limit=<n>&offset=<n>
```

- **`match`** is `word` (the default) or `contains`; see [Match modes](#match-modes). Any other value
  is a `400`.

- **`q`** is required and must be non-empty (whitespace-only is rejected with `400`, and so is one
  longer than 1000 characters or with more than 32 words, punctuation separating words as whitespace does and a symbol or emoji that stands apart counting as one; a whitespace-separated word said again counts once). Numeric params
  are coerced and validated; a non-numeric `limit`/`offset`/`dateFrom`/`dateTo` surfaces as `400`,
  never as a `NaN` SQL parameter.
- **Auth scoping is authoritative.** The caller's API-key `allowedSessions` is injected by
  `SearchService` — **never** accepted from the query — so a scoped key cannot broaden its reach. A
  key with a non-empty `allowedSessions` searches only those sessions, whatever its role, even if it
  passes `sessionId`; a key with a null or empty `allowedSessions` searches all sessions. The DTO
  carries no `sessionIds` field (it would be rejected as non-whitelisted).
- **Chat scope applies the same way.** A key with a non-empty `allowedChats` searches only those
  chats: the built-in provider narrows its hits before `limit`, `offset` and `total` apply, an explicit
  `chatId` outside the allowlist answers `403`, and a plugin provider answers `403` for such a key
  (set `SEARCH_PROVIDER=builtin-fts` to allow scoped search). On SQLite the `match=word` hits of a key
  scoped to sessions or chats carry no `score`, because the value is computed over the whole index and
  would reflect messages outside its scope; the hits stay in relevance order. A `match=contains` score
  reads only its own message, so every key gets it.
- **Response** is a `SearchResults` object: `{ hits: SearchHit[], total, tookMs, provider }`. Each hit
  carries `messageId`, `waMessageId`, `sessionId`, `chatId`, `body`, `snippet`, `timestamp`, `type`,
  `direction`, `from`, and optional `score`. `total` is an exact count (bounded; computed lazily only
  when the page could be full). `tookMs` is the provider-side query time. `provider` names which
  backend answered (e.g. `builtin-fts`).
- **Errors:** `400` empty/whitespace `q`, a non-numeric numeric param, an unknown `match`, or a
  `match=contains` query whose terms are all shorter than three characters (an FTS5 query-grammar error
  is also mapped to `400`, but since the SQLite path quotes every token ordinary input no longer reaches
  that fallback) · `401`/`403` auth · `501` no provider configured / FTS schema absent (e.g. a non-FTS5
  SQLite build) / for `match=contains`, the trigram index absent (e.g. Postgres without `pg_trgm` and
  `unaccent`) · `502` a plugin provider returned a malformed `SearchResults` payload · `503` a plugin
  provider whose worker timed out or failed (the built-in provider does not return it).

The endpoint requires at least `OPERATOR` role.

## 26.7 When to use a plugin backend

The built-in DB full-text provider is the right default for the common case: moderate volume, Latin and
mixed-Script text, whole-token matching (phrase and boolean operators only on Postgres — see §26.3) or
case- and accent-insensitive substring matching (`match=contains`), and no extra infrastructure. Reach
for a plugin provider when you need capabilities the SQL engines do not give you:

- **CJK word-segmentation and morphological analysis** — Postgres `'simple'` and SQLite FTS5 tokenize
  on whitespace/punctuation, which does not segment Chinese/Japanese/Korean. A dedicated engine
  (Meilisearch, and others) segments CJK correctly.
- **Typo-tolerance / fuzzy matching** — the built-in matches terms as the engine's tokenizer produces
  them; it does not do Levenshtein-style "did you mean" correction. A search engine backend does.
- **Large-scale relevance and ranking tuning** — at high row counts or with complex relevance needs
  (field weights, synonyms, stop-word lists, custom ranking), a purpose-built search server
  outperforms a relational FTS query and is tunable without touching the message schema.

The upgrade path is a **search-provider plugin**. The host→plugin search RPC has shipped, so a plugin
registers as a `SearchProvider`, indexes via the `message:persisted` plugin hook (so it stays current
without coupling to the message/session services), and becomes the active backend under the default
`SEARCH_PROVIDER=auto`. No reference plugin is published yet — see
[27 - Writing a Search-Provider Plugin](./27-plugin-search-providers.md) for the author's contract.
Because the route and the response shape are identical across providers, dashboard panels and SDKs
keep working unchanged when you switch backends.

> **Backfill is the plugin's responsibility.** The `message:persisted` hook fires only for **live**
> traffic — outbound on send, inbound on receive, and again when a stored message is revoked (see
> [27.3](./27-plugin-search-providers.md#273-indexing-via-the-messagepersisted-hook)) — never for
> history-backfill persistence. So a plugin provider installed on a deployment that already has message
> history must perform its own one-time backfill at enablement, through `ctx.engine.getChats` +
> `getChatHistory` (needs `engine:read`, works on whatsapp-web.js only and returns at most 100 messages
> per chat; Baileys has no backfill path, see
> [27.3](./27-plugin-search-providers.md#273-indexing-via-the-messagepersisted-hook)); its index
> will otherwise miss pre-installation rows. The built-in DB-FTS provider is
> unaffected — its index is DB-synced via triggers on every insert, including backfill.

## 26.8 Migration and backfill

Adding search to an existing deployment runs the one-time `1782400000000-AddMessagesFts` migration:

- **PostgreSQL** adds the generated `body_ts` column and the `GIN` index. The column is populated for
  all existing rows by Postgres as the `ALTER TABLE ... ADD COLUMN` applies, and the GIN index builds
  **non-`CONCURRENTLY`** (a one-time blocking build). On a very large `messages` table this can hold
  writes for a while — run the upgrade during a **maintenance window**. (You can set `SEARCH_ENABLED=false`
  to skip wiring the route while the migration runs; the migration applies regardless.)
- **SQLite** creates the `messages_fts` virtual table, backfills from the existing `messages` rows in
  one `INSERT ... SELECT`, and installs the sync triggers. This is fast for typical SQLite row counts
  but scales with table size.

The migration is safe to re-run (idempotent guards) and has a `down` path that drops the FTS schema on
both dialects. After it applies, search works immediately — no separate reindex command.

`match=contains` adds the one-time `1792400000000-AddMessagesTrigramSearch` migration:

- **PostgreSQL** creates the `pg_trgm` and `unaccent` extensions inside a savepoint (a role that may
  not create them rolls back to it and the migration stops there, see [Match modes](#match-modes)), the
  IMMUTABLE `openwa_unaccent(text)` wrapper, a `GIN` trigram index on `openwa_unaccent(body)` and the
  `idx_messages_created_at_id` b-tree on `("createdAt", "id")` that serves the candidate window (the
  existing message indexes all lead with `sessionId`). Both are built **non-`CONCURRENTLY`**: plan a
  maintenance window for a very large table.
- **SQLite** creates the `messages_trgm` FTS5 trigram table, backfills it like `messages_fts` and
  installs its own three sync triggers. A trigram index holds every three-character window of the
  body, so it takes noticeably more space than the word index.

Its `down` path drops what it created except the Postgres extensions, which other objects may use.

---

> See also: [06 - API Specification](./06-api-specification.md) (§6.4.12 Search),
> [05 - Database Design](./05-database-design.md),
> [03 - System Architecture](./03-system-architecture.md),
> [19 - Plugin Architecture](./19-plugin-architecture.md),
> [15 - Project Roadmap](./15-project-roadmap.md).
