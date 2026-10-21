/* istanbul ignore file -- PG-gated: only runs under DATABASE_TYPE=postgres (test-postgres CI job);
   skipped in the default test job, so its lines would be unread and skew the global coverage gate. */
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BuiltInFtsProvider } from '../../../modules/search/providers/builtin-fts.provider';
import { AddMessagesFts1782400000000 } from '../1782400000000-AddMessagesFts';
import { AddMessagesTrigramSearch1792400000000 } from '../1792400000000-AddMessagesTrigramSearch';

/**
 * Postgres runtime coverage for match=contains: the pg_trgm/unaccent schema the 1792400000000
 * migration builds, queried through BuiltInFtsProvider. Companion to the SQLite spec
 * (builtin-fts.provider.contains.spec.ts); asserts the same contract (substring, case- and
 * accent-insensitive, every term required, short terms narrowing, literal wildcards, exact totals)
 * plus what only Postgres has: word_similarity ranking and the GIN index actually answering the query.
 *
 * Gated and provisioned exactly like 1782400000000-AddMessagesFts.pg.spec.ts: skipped unless
 * DATABASE_TYPE=postgres, connecting with DATABASE_HOST/PORT/USERNAME/PASSWORD/NAME. The role must be
 * allowed to create the two extensions (the CI postgres:16 service's owner role is).
 */
const POSTGRES_ENABLED = process.env.DATABASE_TYPE === 'postgres';

(POSTGRES_ENABLED ? describe : describe.skip)('AddMessagesTrigramSearch + match=contains (postgres)', () => {
  let ds: DataSource;
  let provider: BuiltInFtsProvider;

  const insert = (id: string, sessionId: string, body: string, ts: number) =>
    ds.query(
      `INSERT INTO "messages" ("id","sessionId","chatId","from","to","body","type","direction","timestamp") ` +
        `VALUES ($1,$2,$3,$4,'dest@c.us',$5,'text','incoming',$6)`,
      [id, sessionId, `${id}-chat`, `${id}-from`, body, ts],
    );

  beforeEach(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'openwa',
      password: process.env.DATABASE_PASSWORD || 'openwa',
      database: process.env.DATABASE_NAME || 'openwa',
    });
    await ds.initialize();
    await ds.query(`DROP TABLE IF EXISTS "messages" CASCADE`);
    await ds.query(`DROP FUNCTION IF EXISTS openwa_unaccent(text)`);
    await ds.query(
      `CREATE TABLE "messages" (` +
        `"id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "waMessageId" varchar, ` +
        `"chatId" varchar NOT NULL, "from" varchar NOT NULL, "to" varchar NOT NULL, "body" text, ` +
        `"type" varchar NOT NULL DEFAULT 'text', "direction" varchar NOT NULL DEFAULT 'outgoing', ` +
        `"timestamp" bigint, "status" varchar NOT NULL DEFAULT 'sent', ` +
        `"createdAt" timestamp NOT NULL DEFAULT now())`,
    );
    await new AddMessagesFts1782400000000().up(ds.createQueryRunner());
    await new AddMessagesTrigramSearch1792400000000().up(ds.createQueryRunner());
    provider = new BuiltInFtsProvider(ds);

    await insert('m1', 's1', 'Your invoice INV-2048 is ready for download', 10);
    await insert('m2', 's1', 'Thanks, I will pay the invoice today', 20);
    await insert('m3', 's2', 'Meeting moved to the Café Résumé at 10am', 30);
    await insert('m4', 's1', 'Order shipped with a 10% discount, tracking id 42', 40);
  });

  afterEach(async () => {
    if (ds && ds.isInitialized) {
      await ds.query(`DROP TABLE IF EXISTS "messages" CASCADE`).catch(() => undefined);
      await ds.query(`DROP FUNCTION IF EXISTS openwa_unaccent(text)`).catch(() => undefined);
      await ds.destroy();
    }
  });

  it('finds any part of a word, ignoring case and accents, and marks it', async () => {
    const res = await provider.search({ q: 'voic', match: 'contains' });
    expect(res.total).toBe(2);
    expect(res.hits.map(h => h.snippet).sort()).toEqual([
      'Thanks, I will pay the in<mark>voic</mark>e today',
      'Your in<mark>voic</mark>e INV-2048 is ready for download',
    ]);

    for (const q of ['cafe', 'CAFÉ', 'resume']) {
      expect((await provider.search({ q, match: 'contains' })).hits.map(h => h.messageId)).toEqual(['m3']);
    }
  });

  it('requires every term, narrows with short ones, and rejects short terms alone', async () => {
    expect((await provider.search({ q: 'invoice 2048', match: 'contains' })).hits.map(h => h.messageId)).toEqual([
      'm1',
    ]);
    expect((await provider.search({ q: 'invoice to', match: 'contains' })).hits.map(h => h.messageId)).toEqual(['m2']);
    await expect(provider.search({ q: 'id to', match: 'contains' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('matches LIKE wildcards in a term literally', async () => {
    expect((await provider.search({ q: '10%', match: 'contains' })).total).toBe(1);
    expect((await provider.search({ q: 'invoice _', match: 'contains' })).total).toBe(0);
  });

  it('ranks whole words first, newest first within a score, and scores a scoped caller too', async () => {
    await insert('m5', 's1', 'reinvoiced items are listed below', 50);
    const res = await provider.search({ q: 'invoice', match: 'contains', sessionIds: ['s1'] });

    expect(res.hits.map(h => [h.messageId, h.score])).toEqual([
      ['m2', 3],
      ['m1', 3],
      ['m5', 1],
    ]);
  });

  it('pages with the window total', async () => {
    const page = await provider.search({ q: 'invoice', match: 'contains', limit: 1, offset: 1 });
    expect(page.total).toBe(2);
    expect(page.hits).toHaveLength(1);
  });

  // A four-row table is cheaper to scan than to look up, so the planner is told not to scan: what
  // these prove is that the SQL the provider emits matches the indexed expressions and CAN use them.
  // One query runner keeps SET LOCAL and EXPLAIN on the same connection and transaction.
  const plan = async (settings: string[], sql: string, params: unknown[]): Promise<string> => {
    const runner = ds.createQueryRunner();
    await runner.startTransaction();
    try {
      for (const setting of settings) await runner.query(`SET LOCAL ${setting} = off`);
      const rows = (await runner.query(`EXPLAIN ${sql}`, params)) as Array<{ 'QUERY PLAN': string }>;
      return rows.map(r => r['QUERY PLAN']).join('\n');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  };

  it('answers the substring predicate from the GIN trigram index', async () => {
    const sql = `SELECT 1 FROM messages m WHERE openwa_unaccent(m."body") ILIKE openwa_unaccent($1)`;
    expect(await plan(['enable_seqscan'], sql, ['%voic%'])).toContain('idx_messages_body_trgm');
  });

  it('can fetch the most recently stored candidates by walking the recency index', async () => {
    const sql =
      `SELECT 1 FROM messages m WHERE openwa_unaccent(m."body") ILIKE openwa_unaccent($1) ` +
      `ORDER BY m."createdAt" DESC, m."id" DESC LIMIT 1000`;
    expect(await plan(['enable_seqscan', 'enable_bitmapscan'], sql, ['%voic%'])).toContain(
      'Index Scan Backward using idx_messages_created_at_id',
    );
  });

  it('builds the function and both indexes at boot when only the extensions exist', async () => {
    await new AddMessagesTrigramSearch1792400000000().down(ds.createQueryRunner());
    const fresh = new BuiltInFtsProvider(ds);
    await fresh.onModuleInit();

    expect((await fresh.search({ q: 'voice', match: 'contains' })).total).toBe(2);
    const indexes = await ds.query<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'messages' AND indexname IN ('idx_messages_body_trgm', 'idx_messages_created_at_id') ORDER BY indexname`,
    );
    expect(indexes.map(i => i.indexname)).toEqual(['idx_messages_body_trgm', 'idx_messages_created_at_id']);
  });
});
