import 'reflect-metadata';
import { BadRequestException, NotImplementedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Message, MessageDirection } from '../../../modules/message/entities/message.entity';
import { Session } from '../../../modules/session/entities/session.entity';
import { AddMessagesFts1782400000000 } from '../../../database/migrations/1782400000000-AddMessagesFts';
import { AddMessagesTrigramSearch1792400000000 } from '../../../database/migrations/1792400000000-AddMessagesTrigramSearch';
import { SEARCH_CONTAINS_WINDOW } from '../search.constants';
import {
  BuiltInFtsProvider,
  postgresUnaccentFunctionDdl,
  sqliteSupportsTrigramDiacritics,
} from './builtin-fts.provider';

/**
 * SQLite runtime coverage for match=contains: the FTS5 trigram index the 1792400000000 migration
 * builds, queried through BuiltInFtsProvider. Companion to builtin-fts.provider.spec.ts (match=word);
 * the Postgres branch runs in 1792400000000-AddMessagesTrigramSearch.pg.spec.ts.
 */
const row = (sessionId: string, chatId: string, body: string, direction: MessageDirection, timestamp: number) => ({
  sessionId,
  chatId,
  from: `${chatId}@c.us`,
  to: 'me@c.us',
  body,
  type: 'text',
  direction,
  timestamp,
});

async function boot(options: { trigramMigration: boolean }): Promise<DataSource> {
  const ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [Session, Message],
    synchronize: true,
  });
  await ds.initialize();
  await new AddMessagesFts1782400000000().up(ds.createQueryRunner());
  if (options.trigramMigration) await new AddMessagesTrigramSearch1792400000000().up(ds.createQueryRunner());
  await ds
    .getRepository(Message)
    .insert([
      row('s1', 'c1', 'Your invoice INV-2048 is ready for download', MessageDirection.INCOMING, 10),
      row('s1', 'c2', 'Thanks, I will pay the invoice today', MessageDirection.OUTGOING, 20),
      row('s2', 'c3', 'Meeting moved to the Café Résumé at 10am', MessageDirection.INCOMING, 30),
      row('s1', 'c4', 'Order shipped with a 10% discount, tracking id 42', MessageDirection.INCOMING, 40),
    ]);
  return ds;
}

describe('BuiltInFtsProvider match=contains (sqlite)', () => {
  let ds: DataSource;
  let provider: BuiltInFtsProvider;

  beforeEach(async () => {
    ds = await boot({ trigramMigration: true });
    provider = new BuiltInFtsProvider(ds);
  });
  afterEach(async () => {
    await ds.destroy();
  });

  it('finds any part of a word and marks it in the snippet', async () => {
    const res = await provider.search({ q: 'voic', match: 'contains' });

    expect(res.total).toBe(2);
    expect(res.hits.map(h => h.snippet).sort()).toEqual([
      'Thanks, I will pay the in<mark>voic</mark>e today',
      'Your in<mark>voic</mark>e INV-2048 is ready for download',
    ]);
  });

  it('ignores case and accents in both the query and the body', async () => {
    for (const q of ['cafe', 'CAFÉ', 'resume']) {
      const res = await provider.search({ q, match: 'contains' });
      expect(res.hits.map(h => h.chatId)).toEqual(['c3']);
    }
  });

  it('requires every term, as match=word does', async () => {
    const res = await provider.search({ q: 'invoice 2048', match: 'contains' });

    expect(res.hits.map(h => h.chatId)).toEqual(['c1']);
    expect(res.hits[0].snippet).toBe('Your <mark>invoice</mark> INV-<mark>2048</mark> is ready for download');
  });

  it('narrows with a term shorter than a trigram instead of dropping it', async () => {
    expect((await provider.search({ q: 'invoice to', match: 'contains' })).hits.map(h => h.chatId)).toEqual(['c2']);
    expect((await provider.search({ q: 'tracking id', match: 'contains' })).total).toBe(1);
  });

  it('rejects a query made only of terms shorter than a trigram', async () => {
    await expect(provider.search({ q: 'id to', match: 'contains' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('matches a LIKE wildcard in a term literally', async () => {
    expect((await provider.search({ q: '10%', match: 'contains' })).total).toBe(1);
    expect((await provider.search({ q: 'invoice _', match: 'contains' })).total).toBe(0);
  });

  it('ranks whole words, then word starts, then the rest, newest first within a score', async () => {
    await ds
      .getRepository(Message)
      .insert([
        row('s1', 'c5', 'Reinvoice requested by finance', MessageDirection.INCOMING, 60),
        row('s1', 'c6', 'Invoiced orders are listed below', MessageDirection.INCOMING, 50),
      ]);

    const res = await provider.search({ q: 'invoice', match: 'contains' });

    expect(res.hits.map(h => [h.chatId, h.score])).toEqual([
      ['c2', 3],
      ['c1', 3],
      ['c6', 2],
      ['c5', 1],
    ]);
  });

  it('pages the ranked window with a stable order and its total', async () => {
    const all = await provider.search({ q: 'invoice', match: 'contains' });
    const page1 = await provider.search({ q: 'invoice', match: 'contains', limit: 1 });
    const page2 = await provider.search({ q: 'invoice', match: 'contains', limit: 1, offset: 1 });

    expect(page1.total).toBe(2);
    expect([...page1.hits, ...page2.hits].map(h => h.messageId)).toEqual(all.hits.map(h => h.messageId));
    expect((await provider.search({ q: 'invoice', match: 'contains', offset: 2 })).hits).toEqual([]);
  });

  it('ranks only the most recently stored matches, so one search does bounded work', async () => {
    const bulk = Array.from({ length: SEARCH_CONTAINS_WINDOW + 5 }, (_, i) =>
      row('s1', 'c7', `Bulk invoice ${i}`, MessageDirection.INCOMING, 100 + i),
    );
    // In batches: TypeORM re-reads inserted rows with one OR term each, past SQLite's expression depth.
    for (let i = 0; i < bulk.length; i += 200) await ds.getRepository(Message).insert(bulk.slice(i, i + 200));

    const res = await provider.search({ q: 'invoice', match: 'contains', limit: 100, offset: 900 });

    expect(res.total).toBe(SEARCH_CONTAINS_WINDOW);
    expect(Math.min(...res.hits.map(h => h.timestamp))).toBe(100 + 5);

    // The filters apply before the window, so a date bound reaches the matches older than it.
    const older = await provider.search({ q: 'invoice', match: 'contains', dateTo: 99_000 });
    expect(older.hits.map(h => h.chatId)).toEqual(['c2', 'c1']);
    const narrower = await provider.search({ q: 'invoice 2048', match: 'contains' });
    expect(narrower.hits.map(h => h.chatId)).toEqual(['c1']);
  });

  it('applies the structural filters and returns each hit its own score to a scoped caller', async () => {
    const res = await provider.search({ q: 'meeting', match: 'contains', sessionIds: ['s2'] });
    expect(res.hits.map(h => h.chatId)).toEqual(['c3']);
    expect(res.hits[0].score).toBe(3);

    const outgoing = await provider.search({ q: 'invoice', match: 'contains', direction: MessageDirection.OUTGOING });
    expect(outgoing.hits.map(h => h.chatId)).toEqual(['c2']);
    expect((await provider.search({ q: 'invoice', match: 'contains', chatIds: [] })).total).toBe(0);
  });

  it('leaves match=word unchanged: whole words only', async () => {
    expect((await provider.search({ q: 'voic' })).total).toBe(0);
    expect((await provider.search({ q: 'invoice', match: 'word' })).total).toBe(2);
  });

  it('keeps the trigram index in sync on update and delete', async () => {
    const repo = ds.getRepository(Message);
    const target = await repo.findOneByOrFail({ chatId: 'c2' });

    await repo.update({ id: target.id }, { body: 'Thanks, I will pay the receipt today' });
    expect((await provider.search({ q: 'receip', match: 'contains' })).hits.map(h => h.chatId)).toEqual(['c2']);
    expect((await provider.search({ q: 'invoice', match: 'contains' })).total).toBe(1);

    await repo.delete({ id: target.id });
    expect((await provider.search({ q: 'receip', match: 'contains' })).total).toBe(0);
  });
});

describe('BuiltInFtsProvider match=contains without the trigram index (sqlite)', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = await boot({ trigramMigration: false });
  });
  afterEach(async () => {
    await ds.destroy();
  });

  it('answers 501 for match=contains while match=word keeps working', async () => {
    const provider = new BuiltInFtsProvider(ds);

    await expect(provider.search({ q: 'voic', match: 'contains' })).rejects.toBeInstanceOf(NotImplementedException);
    expect((await provider.search({ q: 'invoice' })).total).toBe(2);
  });

  it('builds and backfills the index at boot, as under DATABASE_SYNCHRONIZE=true', async () => {
    const provider = new BuiltInFtsProvider(ds);
    await provider.onModuleInit();

    expect((await provider.search({ q: 'voic', match: 'contains' })).total).toBe(2);
    await ds.getRepository(Message).insert(row('s1', 'c9', 'Invoice reminder', MessageDirection.INCOMING, 50));
    expect((await provider.search({ q: 'voic', match: 'contains' })).total).toBe(3);
  });
});

describe('trigram schema helpers', () => {
  it('requires SQLite 3.45 for the trigram tokenizer with remove_diacritics', () => {
    expect(sqliteSupportsTrigramDiacritics('3.44.2')).toBe(false);
    expect(sqliteSupportsTrigramDiacritics('3.45.0')).toBe(true);
    expect(sqliteSupportsTrigramDiacritics('3.53.4')).toBe(true);
    expect(sqliteSupportsTrigramDiacritics('')).toBe(false);
  });

  it('schema-qualifies the unaccent wrapper, quoting the schema name', () => {
    expect(postgresUnaccentFunctionDdl('public')).toContain(
      `SELECT "public".unaccent('"public".unaccent'::regdictionary, $1)`,
    );
    expect(postgresUnaccentFunctionDdl(`we"ird's`)).toContain(`SELECT "we""ird's".unaccent('"we""ird''s".unaccent'`);
  });
});
