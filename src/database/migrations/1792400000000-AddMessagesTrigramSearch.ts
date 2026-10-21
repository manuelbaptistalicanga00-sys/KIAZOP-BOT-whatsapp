import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the trigram index behind `GET /api/search?match=contains` (substring search, case- and
 * accent-insensitive), next to the word index of 1782400000000-AddMessagesFts:
 *  - SQLite: an FTS5 external-content table with the trigram tokenizer (remove_diacritics), keyed on
 *    the implicit `rowid`, kept in sync by triggers and backfilled once, exactly like `messages_fts`.
 *  - Postgres: the pg_trgm and unaccent extensions, an IMMUTABLE `openwa_unaccent(text)` wrapper, a
 *    GIN trigram index on `openwa_unaccent(body)`, and a b-tree on `("createdAt", "id")`. A contains
 *    search ranks the most recently stored matches (SEARCH_CONTAINS_WINDOW); the existing message
 *    indexes all lead with `sessionId`, so without this one a common term would sort every match to
 *    find them. SQLite needs no counterpart: FTS5 walks its doclist in rowid (insertion) order.
 *
 * Never fails the boot over a missing capability. A SQLite build without FTS5 or older than 3.45 (the
 * first with remove_diacritics for trigram) gets no schema, and a Postgres role that may not create
 * the extensions gets the extension attempt rolled back to a savepoint and nothing else. In both cases
 * the provider answers 501 for match=contains only; match=word is untouched. On Postgres the provider
 * creates the function and indexes at a later boot once an operator has installed the extensions.
 *
 * Non-CONCURRENTLY on PG (one-time blocking build), as the word index. For very large `messages` tables,
 * run the upgrade during a maintenance window.
 *
 * Mirrored by BuiltInFtsProvider.ensureTrigramSchema, which brings the same schema up under
 * DATABASE_SYNCHRONIZE=true, where migrations never run. Kept self-contained rather than importing the
 * provider's helpers, so a later change to the provider cannot rewrite what this migration did.
 */
export class AddMessagesTrigramSearch1792400000000 implements MigrationInterface {
  name = 'AddMessagesTrigramSearch1792400000000';

  async up(qr: QueryRunner): Promise<void> {
    if (qr.dataSource.options.type === 'postgres') {
      await this.upPostgres(qr);
      return;
    }
    const [probe] = (await qr.query(
      `SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled, sqlite_version() AS version`,
    )) as Array<{ enabled: number; version: string }>;
    const [major, minor] = String(probe?.version ?? '')
      .split('.')
      .map(Number);
    if (!Number(probe?.enabled) || !(major > 3 || (major === 3 && minor >= 45))) return;

    await qr.query(
      `CREATE VIRTUAL TABLE IF NOT EXISTS "messages_trgm" USING fts5(body, content='messages', content_rowid='rowid', tokenize='trigram remove_diacritics 1')`,
    );
    await qr.query(
      `INSERT INTO "messages_trgm"("rowid", "body") SELECT "rowid", "body" FROM "messages" WHERE "body" IS NOT NULL`,
    );
    await qr.query(`DROP TRIGGER IF EXISTS messages_trgm_ai`);
    await qr.query(`CREATE TRIGGER messages_trgm_ai AFTER INSERT ON "messages" BEGIN
      INSERT INTO "messages_trgm"("rowid", "body") VALUES (new."rowid", new."body");
    END`);
    await qr.query(`DROP TRIGGER IF EXISTS messages_trgm_ad`);
    await qr.query(`CREATE TRIGGER messages_trgm_ad AFTER DELETE ON "messages" BEGIN
      INSERT INTO "messages_trgm"("messages_trgm", "rowid", "body") VALUES ('delete', old."rowid", old."body");
    END`);
    await qr.query(`DROP TRIGGER IF EXISTS messages_trgm_au`);
    // Same WHEN guard as messages_fts_au: acks, reactions and status updates do not touch the body, so
    // they skip the delete+insert on the busiest message path.
    await qr.query(`CREATE TRIGGER messages_trgm_au AFTER UPDATE ON "messages" WHEN OLD.body IS NOT NEW.body BEGIN
      INSERT INTO "messages_trgm"("messages_trgm", "rowid", "body") VALUES ('delete', old."rowid", old."body");
      INSERT INTO "messages_trgm"("rowid", "body") VALUES (new."rowid", new."body");
    END`);
  }

  async down(qr: QueryRunner): Promise<void> {
    if (qr.dataSource.options.type === 'postgres') {
      // The extensions stay: other objects in the database may depend on them.
      await qr.query(`DROP INDEX IF EXISTS "idx_messages_created_at_id"`);
      await qr.query(`DROP INDEX IF EXISTS "idx_messages_body_trgm"`);
      await qr.query(`DROP FUNCTION IF EXISTS openwa_unaccent(text)`);
      return;
    }
    await qr.query(`DROP TRIGGER IF EXISTS messages_trgm_au`);
    await qr.query(`DROP TRIGGER IF EXISTS messages_trgm_ad`);
    await qr.query(`DROP TRIGGER IF EXISTS messages_trgm_ai`);
    await qr.query(`DROP TABLE IF EXISTS "messages_trgm"`);
  }

  private async upPostgres(qr: QueryRunner): Promise<void> {
    // Guards the index build against a role- or database-level statement_timeout, as 1782400000000 does.
    await qr.query('SET LOCAL statement_timeout = 0');
    if (!(await this.createExtensions(qr))) return;

    const [schemas] = (await qr.query(
      `SELECT (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm') AS trgm,
              (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'unaccent') AS unaccent`,
    )) as Array<{ trgm: string; unaccent: string }>;
    const trgm = `"${schemas.trgm.replace(/"/g, '""')}"`;
    const unaccent = `"${schemas.unaccent.replace(/"/g, '""')}"`;

    // unaccent() is STABLE and Postgres indexes only IMMUTABLE expressions. Naming the dictionary and
    // schema-qualifying both references pins what the wrapper calls whatever the caller's search_path,
    // which is what makes declaring it IMMUTABLE safe.
    await qr.query(
      `CREATE OR REPLACE FUNCTION openwa_unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$ SELECT ${unaccent}.unaccent('${unaccent.replace(/'/g, "''")}.unaccent'::regdictionary, $1) $$`,
    );
    await qr.query(
      `CREATE INDEX IF NOT EXISTS "idx_messages_body_trgm" ON "messages" USING GIN (openwa_unaccent("body") ${trgm}.gin_trgm_ops)`,
    );
    await qr.query(`CREATE INDEX IF NOT EXISTS "idx_messages_created_at_id" ON "messages" ("createdAt", "id")`);
  }

  /**
   * Both extensions ship with PostgreSQL's contrib package and are trusted from PostgreSQL 13, so a
   * database owner can create them; managed Postgres may still refuse. A failed statement aborts the
   * surrounding migration transaction, so the attempt runs inside a savepoint and a refusal rolls back
   * to it, leaving the rest of the chain to run. Returns whether both are installed.
   */
  private async createExtensions(qr: QueryRunner): Promise<boolean> {
    const inTransaction = qr.isTransactionActive;
    if (inTransaction) await qr.query('SAVEPOINT trigram_extensions');
    try {
      await qr.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await qr.query('CREATE EXTENSION IF NOT EXISTS unaccent');
      if (inTransaction) await qr.query('RELEASE SAVEPOINT trigram_extensions');
      return true;
    } catch {
      if (inTransaction) await qr.query('ROLLBACK TO SAVEPOINT trigram_extensions');
      return false;
    }
  }
}
