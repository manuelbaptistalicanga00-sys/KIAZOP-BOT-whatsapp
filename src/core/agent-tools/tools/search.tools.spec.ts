import { BadRequestException, ForbiddenException, NotImplementedException } from '@nestjs/common';
import { ChatScopeService } from '../../../modules/auth/chat-scope.service';
import type { AuthService } from '../../../modules/auth/auth.service';
import type { SearchService } from '../../../modules/search/search.service';
import { invokeTool } from '../tool-invoker';
import { searchTools } from './search.tools';

const CHAT = '628111000111@c.us';
const OTHER = '628222000222@c.us';
const results = { hits: [], total: 0, tookMs: 1, provider: 'builtin-fts' };

function authFor(key: object): AuthService {
  return {
    validateApiKey: jest.fn().mockResolvedValue(key),
    hasPermission: jest.fn().mockReturnValue(true),
  } as unknown as AuthService;
}

describe('MessageSearch tool', () => {
  const search = jest.fn().mockResolvedValue(results);
  const tool = searchTools({ search } as unknown as SearchService)[0];
  const call = (key: object, input: unknown) =>
    invokeTool(tool, input, 'key', authFor(key), undefined, undefined, new ChatScopeService());

  beforeEach(() => search.mockClear());

  it('forwards the query with the key session scope and no chat scope for an unrestricted key', async () => {
    const key = { id: 'k1', allowedSessions: ['s1'], allowedChats: null };
    const input = { q: 'invoice', match: 'word', from: '628111000111', direction: 'incoming', dateFrom: 1, limit: 10 };

    await expect(call(key, input)).resolves.toBe(results);

    expect(search).toHaveBeenCalledWith(input, ['s1'], undefined);
  });

  it('searches every session with match=contains when the agent names neither', async () => {
    await call({ id: 'k1', allowedSessions: null, allowedChats: null }, { q: 'invoice' });

    expect(search).toHaveBeenCalledWith({ q: 'invoice', match: 'contains' }, undefined, undefined);
  });

  it('rejects an unknown match mode', async () => {
    await expect(call({ id: 'k1', allowedSessions: null }, { q: 'invoice', match: 'fuzzy' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a blank query before searching', async () => {
    await expect(call({ id: 'k1', allowedSessions: null }, { q: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    expect(search).not.toHaveBeenCalled();
  });

  describe('for a key restricted to selected chats', () => {
    const key = { id: 'k2', allowedSessions: null, allowedChats: [CHAT] };

    it('requires a chatId', async () => {
      await expect(call(key, { q: 'invoice' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(search).not.toHaveBeenCalled();
    });

    it('refuses a chat outside the allowlist', async () => {
      await expect(call(key, { q: 'invoice', chatId: OTHER })).rejects.toBeInstanceOf(ForbiddenException);
      expect(search).not.toHaveBeenCalled();
    });

    it('passes the chat allowlist to the provider for an allowed chat', async () => {
      await call(key, { q: 'invoice', chatId: CHAT });

      expect(search).toHaveBeenCalledWith(
        { q: 'invoice', match: 'contains', chatId: CHAT },
        undefined,
        expect.arrayContaining([CHAT]),
      );
    });
  });

  it('answers 501 when the search module is disabled', async () => {
    const disabled = searchTools(undefined)[0];

    await expect(
      invokeTool(disabled, { q: 'invoice' }, 'key', authFor({ id: 'k1', allowedSessions: null })),
    ).rejects.toBeInstanceOf(NotImplementedException);
  });
});
