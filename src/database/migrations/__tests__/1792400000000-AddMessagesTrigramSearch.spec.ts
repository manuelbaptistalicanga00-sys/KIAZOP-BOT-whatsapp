import 'reflect-metadata';
import { DataSource, QueryRunner } from 'typeorm';
import { Message, MessageDirection } from '../../../modules/message/entities/message.entity';
import { Session } from '../../../modules/session/entities/session.entity';
import { AddMessagesTrigramSearch1792400000000 } from '../1792400000000-AddMessagesTrigramSearch';

/**
 * SQLite in-memory coverage for the AddMessagesTrigramSearch migration, plus the capability gates of
 * both dialects through stub query runners:
 *  - the FTS5 trigram table + 3 sync triggers are created, backfilled, and kept in sync;
 *  - re-running up() is a no-op and down() removes all four objects;
 *  - a SQLite build without FTS5, or older than 3.45, gets no schema and no error;
 *  - a Postgres role refused CREATE EXTENSION rolls back to the savepoint and stops there.
 *
 * The Postgres objects themselves are exercised in 1792400000000-AddMessagesTrigramSearch.pg.spec.ts.
 */
describe('AddMessagesTrigramSearch migration (sqlite)', () => {
  let ds: DataSource;
  let runner: QueryRunner;

  const insert = (body: string | null) =>
    ds.getRepository(Message).insert({
      sessionId: 's1',
      chatId: 'c1',
      from: 'a@c.us',
      to: 'b@c.us',
      body: body as string,
      type: 'text',
      direction: MessageDirection.INCOMING,
      timestamp: 1,
    });
  const matches = async (q: string): Promise<number> =>
    (
      (await runner.query(`SELECT count(*) AS n FROM messages_trgm WHERE messages_trgm MATCH ?`, [q])) as Array<{
        n: number;
      }>
    )[0].n;
  const objects = async (): Promise<string[]> =>
    (
      (await runner.query(
        `SELECT name FROM sqlite_master WHERE name = 'messages_trgm' OR name LIKE 'messages_trgm\\_a_' ESCAPE '\\' ORDER BY name`,
      )) as Array<{ name: string }>
    ).map(r => r.name);

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message],
      synchronize: true,
      migrations: [],
    });
    await ds.initialize();
    runner = ds.createQueryRunner();
  });
  afterEach(async () => {
    await ds.destroy();
  });

  it('creates the trigram table and triggers, backfilling the rows already stored', async () => {
    await insert('Meeting at the Café');
    await insert(null);
    await new AddMessagesTrigramSearch1792400000000().up(runner);

    expect(await objects()).toEqual(['messages_trgm', 'messages_trgm_ad', 'messages_trgm_ai', 'messages_trgm_au']);
    expect(await matches('"cafe"')).toBe(1);

    await insert('Your invoice is ready');
    expect(await matches('"voic"')).toBe(1);
  });

  it('is idempotent on re-run and fully reversible', async () => {
    await insert('Your invoice is ready');
    const migration = new AddMessagesTrigramSearch1792400000000();
    await migration.up(runner);
    await migration.down(runner);
    await migration.up(runner);
    expect(await matches('"invo"')).toBe(1);

    await migration.down(runner);
    expect(await objects()).toEqual([]);
  });

  it.each([
    ['a build without FTS5', { enabled: 0, version: '3.53.4' }],
    ['SQLite older than 3.45', { enabled: 1, version: '3.44.2' }],
  ])('creates nothing on %s', async (_label, probe) => {
    const query = jest.fn().mockResolvedValue([probe]);
    const stub = { dataSource: { options: { type: 'better-sqlite3' } }, query } as unknown as QueryRunner;

    await new AddMessagesTrigramSearch1792400000000().up(stub);

    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('AddMessagesTrigramSearch migration (postgres capability gate)', () => {
  it('rolls back to the savepoint and creates nothing else when CREATE EXTENSION is refused', async () => {
    const statements: string[] = [];
    const query = jest.fn((sql: string) => {
      statements.push(sql);
      if (sql.startsWith('CREATE EXTENSION')) return Promise.reject(new Error('permission denied to create extension'));
      return Promise.resolve([]);
    });
    const stub = {
      dataSource: { options: { type: 'postgres' } },
      isTransactionActive: true,
      query,
    } as unknown as QueryRunner;

    await new AddMessagesTrigramSearch1792400000000().up(stub);

    expect(statements).toEqual([
      'SET LOCAL statement_timeout = 0',
      'SAVEPOINT trigram_extensions',
      'CREATE EXTENSION IF NOT EXISTS pg_trgm',
      'ROLLBACK TO SAVEPOINT trigram_extensions',
    ]);
  });
});
