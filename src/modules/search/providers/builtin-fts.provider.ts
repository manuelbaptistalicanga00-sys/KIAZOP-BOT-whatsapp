import { BadRequestException, Injectable, NotImplementedException, OnModuleInit } from '@nestjs/common';
import { createLogger } from '../../../common/services/logger.service';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { MessageType } from '../../../engine/interfaces/whatsapp-engine.interface';
import { MessageDirection } from '../../message/entities/message.entity';
import type { SearchProvider, SearchQuery, SearchResults, SearchHit } from '../search.types';
import { SEARCH_CONTAINS_MIN_TERM_LENGTH, SEARCH_CONTAINS_WINDOW, SEARCH_LIMIT_MAX } from '../search.constants';
import { containsTerms, foldSearchText } from '../search-terms';
import { containsSnippet } from '../search-snippet';
import { containsScore } from '../search-score';

const MAX_SNIPPET_WORDS = 24;

/**
 * One SQLite FTS5 external-content index over `messages.body`, kept in sync by the `<table>_ai/_ad/_au`
 * triggers ensureSqliteIndex creates. `tokenize` is the FTS5 tokenizer spec; absent means FTS5's
 * default (unicode61), which is what the word index has always used.
 */
interface Fts5Index {
  table: string;
  tokenize?: string;
}

/** The match=word index (migration 1782400000000-AddMessagesFts). */
const WORD_INDEX: Fts5Index = { table: 'messages_fts' };

/**
 * The match=contains index (migration 1792400000000-AddMessagesTrigramSearch). The trigram tokenizer
 * indexes every three-character window of the body, so any substring of three or more characters is a
 * lookup instead of a scan; remove_diacritics makes it accent-insensitive like unicode61.
 */
const TRIGRAM_INDEX: Fts5Index = { table: 'messages_trgm', tokenize: 'trigram remove_diacritics 1' };

/**
 * The contains candidate SELECT list. It carries no snippet or score column: searchContains computes
 * both in the application (see containsSnippet and containsScore).
 */
const CONTAINS_COLUMNS = `m."id", m."waMessageId" AS wa_message_id, m."sessionId" AS session_id, m."chatId" AS chat_id, m."from" AS "from", m."body", m."timestamp", m."type", m."direction"`;

/**
 * What the Postgres catalog holds for contains search: the schema of each extension it needs (null when
 * not installed), and whether the `openwa_unaccent` wrapper, the trigram index and the recency index
 * exist.
 */
interface TrigramStateRow {
  trgm: string | null;
  unaccent: string | null;
  fn: boolean;
  idx: boolean;
  recent: boolean;
}

/** Descending string order for the `id` tiebreak, as `ORDER BY "id" DESC` sorts a UUID column. */
function compareDescending(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

/**
 * The trigram tokenizer shipped in SQLite 3.34, but its remove_diacritics option only in 3.45; an older
 * library rejects the whole CREATE VIRTUAL TABLE. better-sqlite3 bundles its own SQLite, so this only
 * fails on a build linked against an old system library, where contains search then answers 501.
 */
export function sqliteSupportsTrigramDiacritics(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major > 3 || (major === 3 && minor >= 45);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * `unaccent()` is STABLE (its result depends on a dictionary that could change), and Postgres only
 * indexes IMMUTABLE expressions, so the trigram index is built on this wrapper. Naming the dictionary
 * explicitly and schema-qualifying both references pins what the wrapper calls regardless of the
 * caller's search_path, which is what makes declaring it IMMUTABLE safe. The schema is whatever the
 * unaccent extension was installed into, read from the catalog.
 */
export function postgresUnaccentFunctionDdl(unaccentSchema: string): string {
  const schema = quoteIdent(unaccentSchema);
  return `CREATE OR REPLACE FUNCTION openwa_unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$ SELECT ${schema}.unaccent('${schema.replace(/'/g, "''")}.unaccent'::regdictionary, $1) $$`;
}

/** A LIKE/ILIKE pattern that finds `term` anywhere, with its own `\`, `%` and `_` matched literally. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

/** Shorter than a trigram once folded, so no trigram index can look it up. */
function isShortTerm(term: string): boolean {
  return [...foldSearchText(term)].length < SEARCH_CONTAINS_MIN_TERM_LENGTH;
}

/** Shape returned by the dialect-specific SELECT in buildSqlite / buildPostgres. */
interface FtsResultRow {
  id: string;
  wa_message_id: string | null;
  session_id: string;
  chat_id: string;
  from: string;
  body: string | null;
  timestamp: string | number | null;
  type: string;
  direction: string;
  snippet: string | null;
  score: number | string | null;
}

interface CountRow {
  n: number | string;
}

/** Returns the next placeholder token (`?` for SQLite, `$n` for Postgres). */
type PlaceholderFn = () => string;

/**
 * Built-in, DB-native full-text provider. Index sync is DB-level (generated tsvector / FTS5 triggers),
 * so this class ONLY queries — it never writes the index. See migration 1782400000000-AddMessagesFts.
 *
 * Two match modes, each on its own index: `word` (the default) matches whole words through the word
 * index above and ranks them in SQL; `contains` matches any substring of three or more characters,
 * case- and accent-insensitively, through the trigram index of migration
 * 1792400000000-AddMessagesTrigramSearch (an FTS5 trigram table on SQLite, a pg_trgm GIN index on
 * Postgres), and ranks a bounded window of candidates in the application (see searchContains).
 */
@Injectable()
export class BuiltInFtsProvider implements SearchProvider, OnModuleInit {
  readonly id = 'builtin-fts';
  readonly label = 'Built-in database full-text search';
  private readonly logger = createLogger('BuiltInFtsProvider');

  // OpenWA has two TypeORM connections (main: auth/audit SQLite, data: messages). Bind explicitly to
  // 'data' so the provider queries the connection that owns the `messages` table + the FTS migration,
  // never the default/`main` one. The bare `DataSource` type alone is ambiguous with two connections.
  constructor(@InjectDataSource('data') private readonly dataSource: DataSource) {}

  /**
   * Self-heals the FTS schema at bootstrap so search works under an opted-in DATABASE_SYNCHRONIZE=true
   * on SQLite (docker-compose.dev.yml sets it; the default is migrations), where TypeORM creates the
   * `messages` table from the entity but NEVER runs migrations — so the migration that establishes
   * `messages_fts` is skipped and search would 501 on a fresh SQLite box. This re-applies the same
   * idempotent DDL as the migration (1782400000000-AddMessagesFts); `IF NOT EXISTS` / `IF NOT` guards
   * make it a no-op once the schema exists, and on Postgres no DDL is issued at all when the catalog
   * already holds the column and index, so migrations-based deployments take no table lock. Probes the
   * result into `ftsAvailable` so the first search() / health() call doesn't re-probe.
   */
  async onModuleInit(): Promise<void> {
    try {
      this.ftsAvailable = await this.ensureFtsSchema();
      if (this.ftsAvailable) {
        this.logger.log('FTS index ready');
      } else {
        this.logger.warn('FTS index unavailable (SQLite built without FTS5); /api/search will return 501');
      }
    } catch (e) {
      // Never fail boot over index creation: the route 501s cleanly via probeFts()/ensureFts() instead.
      this.logger.error(`Failed to ensure FTS schema: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      this.trigramAvailable = await this.ensureTrigramSchema();
      if (this.trigramAvailable) {
        this.logger.log('Trigram index ready');
      } else {
        this.logger.warn('Trigram index unavailable; match=contains searches will return 501');
      }
    } catch (e) {
      this.logger.error(`Failed to ensure trigram schema: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Whether the DB-native FTS schema this provider queries is present. Cached per instance after the
   * first probe. The migration (1782400000000-AddMessagesFts) is what creates it; on a non-FTS5 SQLite
   * build the migration probes + skips, leaving the schema absent — in that state the provider must
   * 501 cleanly (see ensureFts) instead of crashing on a missing table / column.
   */
  private ftsAvailable: boolean | null = null;

  /**
   * Probes the FTS schema once per instance and caches the result. SQLite: look for the `messages_fts`
   * virtual table in sqlite_master. Postgres: look for the generated `body_ts` column on the SAME
   * `messages` table the search queries resolve — see the to_regclass note below. Safe to call
   * repeatedly; only the first successful probe hits the DB and caches.
   */
  private async probeFts(): Promise<boolean> {
    if (this.ftsAvailable !== null) return this.ftsAvailable;
    if (this.dataSource.options.type === 'postgres') {
      // to_regclass('messages') resolves the name through the session search_path — the identical
      // resolution the runtime queries (`FROM messages m`) use, and the data connection pins
      // search_path to `<schema>,public` when POSTGRES_SCHEMA is non-public (app.module.ts). So the
      // probe inspects the table search will actually hit, in the active schema. An unqualified
      // information_schema scan would instead peek across EVERY visible schema and can lie both ways
      // on a custom-schema deployment: a namesake public.messages.body_ts reports FTS present when
      // the active schema lacks it, and a >1-row match (both schemas carry the column) reports it
      // absent. to_regclass returns NULL when `messages` is unresolvable on the path → zero rows →
      // unavailable, so an undeterminable schema fails closed by construction.
      // Fail-closed on probe error (degraded state, e.g. boot ensure left the pool mid-recovery):
      // report unavailable WITHOUT caching, so search() 501s via ensureFts — the same clean posture
      // as a genuinely absent index, never a raw 500 — and a later call re-probes after recovery.
      let rows: unknown[];
      try {
        rows = await this.dataSource.query(
          `SELECT a.attname FROM pg_attribute a WHERE a.attrelid = to_regclass('messages') AND a.attname = 'body_ts' AND NOT a.attisdropped`,
        );
      } catch (e) {
        this.logger.warn(
          `FTS probe failed; treating the index as unavailable: ${e instanceof Error ? e.message : String(e)}`,
        );
        return false;
      }
      this.ftsAvailable = Array.isArray(rows) && rows.length >= 1;
    } else {
      const rows: unknown[] = await this.dataSource.query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'`,
      );
      this.ftsAvailable = Array.isArray(rows) && rows.length === 1;
    }
    return this.ftsAvailable;
  }

  /**
   * Guards search(): if the FTS schema is absent (non-FTS5 SQLite build or a partial state), throw
   * NotImplementedException so the route surfaces 501 — never let a raw missing-table error escape.
   */
  private async ensureFts(): Promise<void> {
    const ok = await this.probeFts();
    if (!ok) {
      throw new NotImplementedException('Search is unavailable: the database has no full-text index.');
    }
  }

  /**
   * Creates the FTS schema if missing. Mirrors migration 1782400000000-AddMessagesFts verbatim and is
   * idempotent (every statement is `IF NOT EXISTS` / `IF NOT`), so:
   *   - migrations-based deployments: the migration has already run; SQLite runs a set of no-ops,
   *     and Postgres reads the catalog and issues no DDL, because `ALTER TABLE ... IF NOT EXISTS`
   *     still queues for ACCESS EXCLUSIVE on `messages` before it finds the column, stalling every
   *     message read and write behind any open transaction.
   *   - synchronize-based SQLite deployments (DATABASE_SYNCHRONIZE=true, e.g. the dev compose):
   *     migrations are skipped, so this is what actually brings the index up at boot. Without it
   *     search 501s on every such box. Postgres refuses synchronize at boot, so the Postgres
   *     branch only repairs a schema whose FTS migration objects are missing.
   * Returns true when the index is usable, false when the SQLite build lacks FTS5 (no schema left
   * behind — the route 501s cleanly via ensureFts).
   */
  private async ensureFtsSchema(): Promise<boolean> {
    const isPostgres = this.dataSource.options.type === 'postgres';
    if (isPostgres) {
      // Uncached on purpose (probeFts caches and swallows errors). Both objects are looked up on the
      // table to_regclass resolves, the same one the runtime queries hit; only a missing one is created.
      const rows: Array<{ col: boolean; idx: boolean }> = await this.dataSource.query(
        `SELECT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('messages') AND a.attname = 'body_ts' AND NOT a.attisdropped) AS col,
                EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = to_regclass('messages') AND c.relname = 'idx_messages_body_ts') AS idx`,
      );
      if (!rows[0]?.col) {
        await this.dataSource.query(
          `ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "body_ts" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED`,
        );
      }
      if (!rows[0]?.idx) {
        await this.dataSource.query(
          `CREATE INDEX IF NOT EXISTS "idx_messages_body_ts" ON "messages" USING GIN ("body_ts")`,
        );
      }
      return true;
    }
    // SQLite: probe FTS5 first; skip leaving any schema if this build lacks it.
    if (!(await this.sqliteHasFts5())) return false;
    await this.ensureSqliteIndex(WORD_INDEX);
    return true;
  }

  /** Whether this SQLite build was compiled with FTS5; neither index can exist without it. */
  private async sqliteHasFts5(): Promise<boolean> {
    const fts5: unknown[] = await this.dataSource.query(`SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled`);
    return Boolean(Number((fts5 as Array<{ enabled: number }>)[0]?.enabled));
  }

  /**
   * Creates one FTS5 index over `messages.body` if missing, repairs its contents, and (re)creates its
   * three sync triggers. Shared by the word and trigram indexes, which differ only in table name and
   * tokenizer, so both get the same repair guarantees. Idempotent: on a healthy index every step is a
   * no-op or a trigger replaced by an identical one.
   */
  private async ensureSqliteIndex({ table, tokenize }: Fts5Index): Promise<void> {
    const docsize = `${table}_docsize`;
    await this.dataSource.query(
      `CREATE VIRTUAL TABLE IF NOT EXISTS "${table}" USING fts5(body, content='messages', content_rowid='rowid'${tokenize ? `, tokenize='${tokenize}'` : ''})`,
    );
    // Backfill the rows this index does not hold. NOT an emptiness test: the index is an FTS5
    // external-content table, so `count(*)` on it scans `messages` and returns THAT table's row
    // count, never the number of indexed documents — a "the index is empty" probe written that way
    // is unsatisfiable, because a zero count means `messages` itself is empty. The indexed documents
    // live in the `<table>_docsize` shadow table, so completeness is a rowid-level anti-join.
    //
    // It has to hold on a PARTIALLY populated index, not just an empty one: once a box has booted
    // once without the backfill, its later writes are indexed by the triggers below while its older
    // rows stay missing, and an emptiness test is false there and repairs nothing. Until those rows
    // are indexed the AFTER UPDATE/DELETE triggers issue FTS5 'delete' commands for documents that
    // were never added, and SQLite rejects the whole statement — so ordinary edits and deletes on
    // them fail, not merely searches. Reads `d."rowid"` rather than `d."id"`: same query plan,
    // without depending on the shadow table's column naming.
    //
    // A rowid-level gap check cannot see a renumbered table. TypeORM synchronize rebuilds `messages`
    // on SQLite by copying the rows without their implicit rowid, so after any delete the survivors
    // get new rowids and the index entries under them describe other messages. The triggers keep
    // `docsize` in step with `messages`, so an index row with no message behind it only appears after
    // such a rebuild, and any rebuild that renumbered a row leaves the old highest rowid behind. Drop
    // the whole index then and let the gap repair below re-add every row.
    const orphanRow: unknown[] = await this.dataSource.query(
      `SELECT EXISTS(SELECT 1 FROM "${docsize}" d
         WHERE NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."rowid" = d."rowid")) AS orphan`,
    );
    if (Number((orphanRow as Array<{ orphan: number }>)[0]?.orphan)) {
      this.logger.warn(`${table} holds rows the messages table no longer has; re-indexing every message`);
      await this.dataSource.query(`INSERT INTO "${table}"("${table}") VALUES ('delete-all')`);
    }
    const gapRow: unknown[] = await this.dataSource.query(
      `SELECT EXISTS(SELECT 1 FROM "messages" m WHERE m."body" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "${docsize}" d WHERE d."rowid" = m."rowid")) AS missing`,
    );
    if (Number((gapRow as Array<{ missing: number }>)[0]?.missing)) {
      // `body IS NOT NULL` mirrors the migration's own backfill exactly: a repair that indexed a NULL
      // body as an empty document would leave the index disagreeing with the schema it repairs.
      await this.dataSource.query(
        `INSERT INTO "${table}"("rowid", "body")
           SELECT m."rowid", m."body" FROM "messages" m WHERE m."body" IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM "${docsize}" d WHERE d."rowid" = m."rowid")`,
      );
    }
    // The three sync triggers are CREATE-OR-REPLACE by name via DROP + CREATE; idempotent on re-run.
    await this.dataSource.query(`DROP TRIGGER IF EXISTS ${table}_ai`);
    await this.dataSource.query(`CREATE TRIGGER ${table}_ai AFTER INSERT ON "messages" BEGIN
      INSERT INTO "${table}"("rowid", "body") VALUES (new."rowid", new."body");
    END`);
    await this.dataSource.query(`DROP TRIGGER IF EXISTS ${table}_ad`);
    await this.dataSource.query(`CREATE TRIGGER ${table}_ad AFTER DELETE ON "messages" BEGIN
      INSERT INTO "${table}"("${table}", "rowid", "body") VALUES ('delete', old."rowid", old."body");
    END`);
    await this.dataSource.query(`DROP TRIGGER IF EXISTS ${table}_au`);
    // WHEN clause skips re-indexing on body-unchanged updates (acks/reactions/status) — mirrors the
    // migration. NULL-safe via `IS NOT` so NULL↔non-NULL body transitions still fire.
    await this.dataSource.query(
      `CREATE TRIGGER ${table}_au AFTER UPDATE ON "messages" WHEN OLD.body IS NOT NEW.body BEGIN
      INSERT INTO "${table}"("${table}", "rowid", "body") VALUES ('delete', old."rowid", old."body");
      INSERT INTO "${table}"("rowid", "body") VALUES (new."rowid", new."body");
    END`,
    );
  }

  /**
   * Brings up the match=contains index at boot, the way ensureFtsSchema does for the word index, and
   * mirrors migration 1792400000000-AddMessagesTrigramSearch. Returns false, leaving no schema behind,
   * when the database cannot hold the index: then only match=contains answers 501, while match=word
   * keeps working.
   */
  private async ensureTrigramSchema(): Promise<boolean> {
    if (this.dataSource.options.type === 'postgres') return this.ensurePostgresTrigramSchema();
    if (!(await this.sqliteHasFts5())) return false;
    const rows: Array<{ version: string }> = await this.dataSource.query(`SELECT sqlite_version() AS version`);
    if (!sqliteSupportsTrigramDiacritics(rows[0]?.version ?? '')) return false;
    await this.ensureSqliteIndex(TRIGRAM_INDEX);
    return true;
  }

  /**
   * Creates the wrapper function, the trigram index and the recency index when they are missing but
   * both extensions are installed. It never runs CREATE EXTENSION: that needs a privilege managed
   * Postgres often withholds, and the migration has already tried it inside a savepoint. An operator
   * who installs the extensions later gets the indexes on the next boot. Like the word index, the
   * builds are not CONCURRENTLY, so a large table is best upgraded in a maintenance window.
   */
  private async ensurePostgresTrigramSchema(): Promise<boolean> {
    const [state] = await this.postgresTrigramState();
    if (!state?.trgm || !state.unaccent) return false;
    if (!state.fn) {
      await this.dataSource.query(postgresUnaccentFunctionDdl(state.unaccent));
    }
    if (!state.idx) {
      await this.dataSource.query(
        `CREATE INDEX IF NOT EXISTS "idx_messages_body_trgm" ON "messages" USING GIN (openwa_unaccent("body") ${quoteIdent(state.trgm)}.gin_trgm_ops)`,
      );
    }
    if (!state.recent) {
      await this.dataSource.query(
        `CREATE INDEX IF NOT EXISTS "idx_messages_created_at_id" ON "messages" ("createdAt", "id")`,
      );
    }
    return true;
  }

  /**
   * One catalog read of everything contains search needs on Postgres. The function and the indexes
   * are looked up through the session search_path, the same resolution the runtime queries use (see
   * the to_regclass note in probeFts).
   */
  private postgresTrigramState(): Promise<TrigramStateRow[]> {
    const indexExists = (name: string) =>
      `EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = to_regclass('messages') AND c.relname = '${name}')`;
    return this.dataSource.query<TrigramStateRow[]>(
      `SELECT (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm') AS trgm,
              (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'unaccent') AS unaccent,
              to_regprocedure('openwa_unaccent(text)') IS NOT NULL AS fn,
              ${indexExists('idx_messages_body_trgm')} AS idx,
              ${indexExists('idx_messages_created_at_id')} AS recent`,
    );
  }

  /** Whether the match=contains index is usable; cached like ftsAvailable after the first probe. */
  private trigramAvailable: boolean | null = null;

  /**
   * Probes the contains index once per instance, with the same fail-closed posture as probeFts: a
   * Postgres probe error reports unavailable without caching, so a later call re-probes.
   */
  private async probeTrigram(): Promise<boolean> {
    if (this.trigramAvailable !== null) return this.trigramAvailable;
    if (this.dataSource.options.type === 'postgres') {
      let state: TrigramStateRow | undefined;
      try {
        [state] = await this.postgresTrigramState();
      } catch (e) {
        this.logger.warn(
          `Trigram probe failed; treating contains search as unavailable: ${e instanceof Error ? e.message : String(e)}`,
        );
        return false;
      }
      // The recency index only speeds up the candidate query; contains search is correct without it.
      this.trigramAvailable = Boolean(state?.trgm && state.fn && state.idx);
    } else {
      const rows: unknown[] = await this.dataSource.query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='${TRIGRAM_INDEX.table}'`,
      );
      this.trigramAvailable = Array.isArray(rows) && rows.length === 1;
    }
    return this.trigramAvailable;
  }

  /** Guards a match=contains search: a missing trigram index is a 501 that names the fix. */
  private async ensureTrigram(): Promise<void> {
    if (await this.probeTrigram()) return;
    throw new NotImplementedException(
      this.dataSource.options.type === 'postgres'
        ? 'Contains search is unavailable: install the pg_trgm and unaccent extensions (CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent;) and restart.'
        : 'Contains search is unavailable: this SQLite build has no FTS5 trigram tokenizer (SQLite 3.45+ is required).',
    );
  }

  async search(query: SearchQuery): Promise<SearchResults> {
    if (query.match === 'contains') return this.searchContains(query);
    await this.ensureFts();
    const start = Date.now();
    const isPostgres = this.dataSource.options.type === 'postgres';
    const limit = Math.max(1, Math.min(query.limit ?? 50, SEARCH_LIMIT_MAX));
    const offset = Math.max(0, query.offset ?? 0);

    const { sql, params } = isPostgres
      ? this.buildPostgres(query, limit, offset)
      : this.buildSqlite(query, limit, offset);

    // SQLite FTS5 treats `"`, `(`, `)`, `*`, and bare OR/AND/NOT/NEAR as query syntax, so a malformed
    // query (`?q="hello`, `?q=(test`, `?q=*foo`) raises one of three query-grammar errors at exec time
    // (`fts5: syntax error`, `unterminated string`, `unknown special query`). Surface those as a 400 —
    // matching Postgres's tolerant websearch_to_tsquery, which has no equivalent failure mode — never a
    // raw 500. Generic DB errors (`no such column`, connection drops) are rethrown unchanged.
    const fts5QueryError = /(fts5:\s*syntax\s*error|unterminated\s+string|unknown\s+special\s+query)/i;
    let rows: FtsResultRow[];
    try {
      rows = await this.dataSource.query<FtsResultRow[]>(sql, params);
    } catch (e) {
      if (!isPostgres && fts5QueryError.test(String(e))) {
        throw new BadRequestException('Malformed search query for SQLite full-text search.');
      }
      throw e;
    }
    const hits: SearchHit[] = rows.map(r => this.mapRow(r));
    const total = rows.length < limit && offset === 0 ? rows.length : await this.count(query, isPostgres);

    return { hits, total, tookMs: Date.now() - start, provider: this.id };
  }

  /**
   * match=contains, in two phases (docs/26, "Match modes"):
   *
   *  1. The database returns at most SEARCH_CONTAINS_WINDOW candidates: the most recently stored
   *     messages that contain every term, found through the trigram index, newest first. Both
   *     dialects answer that order from an index and stop at the window, so the work is bounded
   *     however many messages match.
   *  2. The application ranks the candidates with containsScore (whole word, then word start, then
   *     inside a word), newest first within a score and `id` last for a total order, and pages them in
   *     memory.
   *
   * Ranking every match in SQL instead (bm25 / word_similarity) costs time in proportion to the
   * matches: about 100 ms on SQLite and 1.6 s on Postgres for a term found in 200k of 1M messages, and
   * on SQLite that time blocks the event loop every session shares. With the window the same search
   * takes about 2 ms on SQLite and 10 to 20 ms on Postgres. The price is that relevance only orders
   * the window: `total` is the window's size at most, and older matches are reached by narrowing the
   * query (more terms, chatId, dateTo), since the filters apply before the window. Scoring one row at
   * a time also means a score never reflects messages outside the caller's scope, so unlike bm25 it
   * is never withheld.
   */
  private async searchContains(query: SearchQuery): Promise<SearchResults> {
    const terms = BuiltInFtsProvider.containsTermsOf(query.q);
    await this.ensureTrigram();
    const start = Date.now();
    const limit = Math.max(1, Math.min(query.limit ?? 50, SEARCH_LIMIT_MAX));
    const offset = Math.max(0, query.offset ?? 0);

    const { sql, params } =
      this.dataSource.options.type === 'postgres'
        ? this.buildPostgresCandidates(query, terms)
        : this.buildSqliteCandidates(query, terms);
    const rows = await this.dataSource.query<FtsResultRow[]>(sql, params);

    const ranked = rows
      .map(row => ({ row, score: containsScore(row.body ?? '', terms) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(b.row.timestamp ?? 0) - Number(a.row.timestamp ?? 0) ||
          compareDescending(a.row.id, b.row.id),
      );
    const hits: SearchHit[] = ranked.slice(offset, offset + limit).map(({ row, score }) => ({
      ...this.mapRow(row),
      snippet: containsSnippet(row.body ?? '', terms, MAX_SNIPPET_WORDS),
      score,
    }));

    return { hits, total: ranked.length, tookMs: Date.now() - start, provider: this.id };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    // Reflects FTS availability (not just raw connectivity): a non-FTS5 build reports unhealthy here
    // for callers of health(). DB errors still map to { ok: false }.
    try {
      const ok = await this.probeFts();
      return { ok, detail: ok ? undefined : 'full-text index absent' };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  private mapRow(r: FtsResultRow): SearchHit {
    return {
      messageId: r.id,
      waMessageId: r.wa_message_id ?? '',
      sessionId: r.session_id,
      chatId: r.chat_id,
      body: r.body ?? '',
      snippet: r.snippet ?? '',
      timestamp: Number(r.timestamp ?? 0),
      type: r.type as MessageType,
      direction: r.direction as MessageDirection,
      from: r.from,
      score: r.score == null ? undefined : Number(r.score),
    };
  }

  /**
   * Dialect-aware placeholder generator. SQLite binds `?` positionally by param-array order
   * (so we emit `?` regardless of slot). Postgres binds `$n` positional by the order tokens
   * APPEAR in the final SQL string — so each call returns the next `$n`, and callers MUST
   * invoke it in SQL-appearance order while pushing the matching param in the same step.
   */
  private static sqlitePlaceholder: PlaceholderFn = () => '?';
  private pgPlaceholder(): PlaceholderFn {
    let n = 0;
    return () => `$${++n}`;
  }

  /**
   * Quote every whitespace-separated token (doubling internal quotes) so user input matches
   * LITERALLY. SQLite FTS5 treats `"`, `(`, `)`, `*`, `@`, and bare AND/OR/NOT/NEAR as query
   * grammar, so a raw query (`?q="hello`, `?q=262813461250071@lid`) raises a grammar error at exec
   * time — and phone numbers / chatIds are natural search terms here. Verified against FTS5:
   * `a b` and `"a" "b"` are semantically identical (implicit AND), so multi-token behavior is
   * unchanged. Postgres already uses the tolerant websearch_to_tsquery and needs no equivalent.
   */
  private static toFts5Query(raw: string): string {
    // A repeated token is dropped: `a a` is `a` under implicit AND, but FTS5 would pay for each copy
    // on every matching row.
    const tokens = [...new Set(raw.trim().split(/\s+/).filter(Boolean))];
    if (tokens.length === 0) return '""';
    return tokens.map(tok => `"${tok.replace(/"/g, '""')}"`).join(' ');
  }

  /**
   * The whitespace-separated terms of a contains query, repeats folded away (`Invoice invoice` is one
   * term). Every term must appear in the body, as with match=word. A trigram index cannot answer a term
   * shorter than three characters (FTS5 returns nothing for it, pg_trgm scans every row), so such terms
   * only narrow the rows a longer term already found, and a query made of short terms alone is a 400
   * rather than a full-table scan.
   */
  private static containsTermsOf(q: string): string[] {
    const terms = containsTerms(q);
    if (!terms.some(term => !isShortTerm(term))) {
      throw new BadRequestException(
        `A contains search needs at least one term of ${SEARCH_CONTAINS_MIN_TERM_LENGTH} or more characters.`,
      );
    }
    return terms;
  }

  // --- SQLite FTS5 -----------------------------------------------------------
  // SQL appearance order: MATCH term -> filters -> LIMIT -> OFFSET. Params pushed in that order.
  // Both dialects tiebreak on `m."id"`: neither `rank`/`score` nor the whole-second `timestamp` is
  // unique (a one-word query can score every hit identically), and without a total order a paged
  // walk repeats some hits and never returns others. Measured on Postgres, which sorts a tie group
  // differently per LIMIT/OFFSET: an ordinary search repeated a row by the third page. SQLite was
  // already self-consistent, but it keeps the term so the two dialects page alike; its plan is
  // unchanged (the ORDER BY already needed a temp b-tree) and the extra column costs about a
  // millisecond a page.
  private buildSqlite(q: SearchQuery, limit: number, offset: number) {
    const ph = BuiltInFtsProvider.sqlitePlaceholder;
    const params: unknown[] = [];
    const where: string[] = [`messages_fts MATCH ${ph()}`];
    params.push(BuiltInFtsProvider.toFts5Query(q.q));
    this.applyFilters(where, params, q, 'm.', ph);
    // bm25 weighs a term by how many messages the whole index holds, so the value of a hit a caller
    // scoped to some sessions or chats may read still reflects the ones it may not. It keeps ordering the
    // hits; only the value is withheld. An empty session list is no restriction (applyFilters), an empty
    // chat list is a restriction to nothing.
    const scoped = q.chatIds !== undefined || (q.sessionIds?.length ?? 0) > 0;
    const score = scoped ? 'NULL' : 'rank';
    const cols = `m."id", m."waMessageId" AS wa_message_id, m."sessionId" AS session_id, m."chatId" AS chat_id, m."from" AS "from", m."body", m."timestamp", m."type", m."direction", snippet(messages_fts, 0, '<mark>', '</mark>', '…', ${MAX_SNIPPET_WORDS}) AS snippet, ${score} AS score`;
    const sql = `SELECT ${cols} FROM messages_fts JOIN messages m ON m."rowid" = messages_fts."rowid" WHERE ${where.join(' AND ')} ORDER BY rank, m."timestamp" DESC, m."id" DESC LIMIT ${ph()} OFFSET ${ph()}`;
    params.push(limit, offset);
    return { sql, params };
  }

  // --- Postgres tsvector -----------------------------------------------------
  // SQL appearance order: FTS term (in FROM clause) -> filters (in WHERE) -> LIMIT -> OFFSET.
  // The FTS term lives in `FROM messages m, websearch_to_tsquery('simple', $1) AS q(query)`,
  // which renders BEFORE the WHERE filters — so it must be `$1`, filters `$2..`, LIMIT/OFFSET last.
  // Params are pushed in the same order so the Nth param maps to `$N`.
  private buildPostgres(q: SearchQuery, limit: number, offset: number) {
    const ph = this.pgPlaceholder();
    const params: unknown[] = [];
    const ftsTerm = `websearch_to_tsquery('simple', ${ph()}) AS q(query)`;
    params.push(q.q);
    const where: string[] = [`m.body_ts @@ q.query`];
    this.applyFilters(where, params, q, 'm.', ph);
    // StartSel/StopSel are pinned to <mark>/</mark> to match the SQLite FTS5 snippet() output, so the
    // SearchHit.snippet contract stays dialect-agnostic (PG's ts_headline defaults to <b>/</b>).
    const cols = `m."id", m."waMessageId" AS wa_message_id, m."sessionId" AS session_id, m."chatId" AS chat_id, m."from", m."body", m."timestamp", m."type", m."direction", ts_headline('simple', m."body", q.query, 'MaxFragments=1, MaxWords=${MAX_SNIPPET_WORDS}, StartSel=<mark>, StopSel=</mark>') AS snippet, ts_rank(m.body_ts, q.query) AS score`;
    const sql = `SELECT ${cols} FROM messages m, ${ftsTerm} WHERE ${where.join(' AND ')} ORDER BY score DESC, m."timestamp" DESC, m."id" DESC LIMIT ${ph()} OFFSET ${ph()}`;
    params.push(limit, offset);
    return { sql, params };
  }

  // --- SQLite FTS5 trigram candidates (match=contains) -----------------------
  // SQL appearance order: MATCH term -> short-term LIKEs -> filters -> LIMIT. The trigram tokenizer
  // folds case and, with remove_diacritics, accents, so `cafe` finds `Café` and `voic` finds
  // `Invoice`. A term under three characters cannot be looked up in it and is checked with LIKE on the
  // rows the MATCH kept; SQLite's LIKE folds ASCII case only, which covers the ids and abbreviations
  // such terms usually are (`id`, `pm`, `v2`). FTS5 answers `ORDER BY rowid DESC` from its own doclist
  // order, so the LIMIT stops the walk at the window instead of sorting every match; rowid is the
  // insertion order, so these are the most recently stored matches.
  private buildSqliteCandidates(q: SearchQuery, terms: string[]) {
    const ph = BuiltInFtsProvider.sqlitePlaceholder;
    const params: unknown[] = [];
    const where = [`${TRIGRAM_INDEX.table} MATCH ${ph()}`];
    params.push(BuiltInFtsProvider.toFts5Query(terms.filter(term => !isShortTerm(term)).join(' ')));
    for (const term of terms.filter(isShortTerm)) {
      where.push(`m."body" LIKE ${ph()} ESCAPE '\\'`);
      params.push(likePattern(term));
    }
    this.applyFilters(where, params, q, 'm.', ph);
    const sql = `SELECT ${CONTAINS_COLUMNS} FROM ${TRIGRAM_INDEX.table} JOIN messages m ON m."rowid" = ${TRIGRAM_INDEX.table}."rowid" WHERE ${where.join(' AND ')} ORDER BY ${TRIGRAM_INDEX.table}."rowid" DESC LIMIT ${ph()}`;
    params.push(SEARCH_CONTAINS_WINDOW);
    return { sql, params };
  }

  // --- Postgres pg_trgm candidates (match=contains) --------------------------
  // SQL appearance order: one ILIKE per term -> filters -> LIMIT. Each ILIKE compares
  // openwa_unaccent(body), the exact expression the GIN trigram index holds; ILIKE folds case and
  // openwa_unaccent folds accents, matching the SQLite trigram tokenizer, and each term has its `%`,
  // `_` and `\` escaped so it matches literally. The most recently stored first, as on SQLite:
  // idx_messages_created_at_id lets the planner walk them backward and stop at the window when a term
  // is common, while for a rare one it reads the few matches from the GIN index and sorts them.
  private buildPostgresCandidates(q: SearchQuery, terms: string[]) {
    const ph = this.pgPlaceholder();
    const params: unknown[] = [];
    const where = terms.map(term => {
      const placeholder = ph();
      params.push(likePattern(term));
      return `openwa_unaccent(m."body") ILIKE openwa_unaccent(${placeholder})`;
    });
    this.applyFilters(where, params, q, 'm.', ph);
    const sql = `SELECT ${CONTAINS_COLUMNS} FROM messages m WHERE ${where.join(' AND ')} ORDER BY m."createdAt" DESC, m."id" DESC LIMIT ${ph()}`;
    params.push(SEARCH_CONTAINS_WINDOW);
    return { sql, params };
  }

  /** Emits dialect-correct placeholders. For PG, MUST be called in SQL-appearance order. */
  private applyFilters(where: string[], params: unknown[], q: SearchQuery, prefix: string, ph: PlaceholderFn): void {
    if (q.sessionIds && q.sessionIds.length) {
      const placeholders = q.sessionIds.map(() => ph()).join(',');
      where.push(`${prefix}"sessionId" IN (${placeholders})`);
      params.push(...q.sessionIds);
    }
    if (q.sessionId) {
      where.push(`${prefix}"sessionId" = ${ph()}`);
      params.push(q.sessionId);
    }
    if (q.chatId) {
      // Every stored form of the chat when the host expanded it (a chat first stored under a lid and later
      // under the phone is one chat, as in the message list), the literal id otherwise.
      if (q.chatIdAliases?.length) {
        const placeholders = q.chatIdAliases.map(() => ph()).join(',');
        where.push(`${prefix}"chatId" IN (${placeholders})`);
        params.push(...q.chatIdAliases);
      } else {
        where.push(`${prefix}"chatId" = ${ph()}`);
        params.push(q.chatId);
      }
    }
    if (q.chatIds?.length === 0) where.push('1 = 0');
    else if (q.chatIds) {
      const placeholders = q.chatIds.map(() => ph()).join(',');
      where.push(`${prefix}"chatId" IN (${placeholders})`);
      params.push(...q.chatIds);
    }
    if (q.from) {
      if (q.fromAliases?.length) {
        // A group message keeps the group id in `from` and the person in `author`, so both are matched.
        const asSender = q.fromAliases.map(() => ph()).join(',');
        const asAuthor = q.fromAliases.map(() => ph()).join(',');
        where.push(`(${prefix}"from" IN (${asSender}) OR ${prefix}"author" IN (${asAuthor}))`);
        params.push(...q.fromAliases, ...q.fromAliases);
      } else {
        where.push(`${prefix}"from" = ${ph()}`);
        params.push(q.from);
      }
    }
    if (q.direction) {
      where.push(`${prefix}"direction" = ${ph()}`);
      params.push(q.direction);
    }
    if (q.type) {
      const types = Array.isArray(q.type) ? q.type : [q.type];
      const placeholders = types.map(() => ph()).join(',');
      where.push(`${prefix}"type" IN (${placeholders})`);
      params.push(...types);
    }
    // The public contract (DTO + docs) is epoch-ms, but messages.timestamp stores epoch-seconds
    // (WhatsApp messageTimestamp — see the inbound mappers in the engine adapters). Bind ms→seconds
    // at the boundary, otherwise `seconds >= ms` is false for every modern row and dateFrom/dateTo
    // silently exclude all results.
    if (q.dateFrom != null) {
      where.push(`${prefix}"timestamp" >= ${ph()}`);
      params.push(Math.ceil(q.dateFrom / 1000));
    }
    if (q.dateTo != null) {
      where.push(`${prefix}"timestamp" <= ${ph()}`);
      params.push(Math.floor(q.dateTo / 1000));
    }
  }

  private async count(q: SearchQuery, isPostgres: boolean): Promise<number> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (isPostgres) {
      const ph = this.pgPlaceholder();
      const ftsTerm = `websearch_to_tsquery('simple', ${ph()}) AS q(query)`;
      params.push(q.q);
      where.push(`m.body_ts @@ q.query`);
      this.applyFilters(where, params, q, 'm.', ph);
      const sql = `SELECT count(*)::int AS n FROM messages m, ${ftsTerm} WHERE ${where.join(' AND ')}`;
      const rows = await this.dataSource.query<CountRow[]>(sql, params);
      return Number(rows[0]?.n ?? 0);
    }
    const ph = BuiltInFtsProvider.sqlitePlaceholder;
    where.push(`messages_fts MATCH ${ph()}`);
    params.push(BuiltInFtsProvider.toFts5Query(q.q));
    this.applyFilters(where, params, q, 'm.', ph);
    const sql = `SELECT count(*) AS n FROM messages_fts JOIN messages m ON m."rowid" = messages_fts."rowid" WHERE ${where.join(' AND ')}`;
    const rows = await this.dataSource.query<CountRow[]>(sql, params);
    return Number(rows[0]?.n ?? 0);
  }
}
