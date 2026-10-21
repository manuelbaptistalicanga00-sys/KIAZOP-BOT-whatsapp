import { NotImplementedException } from '@nestjs/common';
import { z } from 'zod';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import { MessageDirection } from '../../../modules/message/entities/message.entity';
import type { SearchService } from '../../../modules/search/search.service';
import {
  SEARCH_CONTAINS_WINDOW,
  SEARCH_LIMIT_MAX,
  SEARCH_MATCH_MODES,
  SEARCH_OFFSET_MAX,
  SEARCH_QUERY_MAX_LENGTH,
} from '../../../modules/search/search.constants';
import { chatIdSchema } from '../chat-id-schema';
import { defineTool, type AnyToolDescriptor } from '../tool-descriptor';

/**
 * Global message search for agents: the same SearchService, scopes and limits as `GET /api/search`.
 *
 * `search` is undefined when SEARCH_ENABLED=false leaves SearchModule out. The tool is still
 * registered, so the published tool surface (and the counts the README states) does not depend on
 * configuration; calling it answers 501, as the REST route answers 404 then.
 */
export function searchTools(search: SearchService | undefined): AnyToolDescriptor[] {
  return [
    defineTool({
      name: 'MessageSearch',
      // A key restricted to selected chats must name an allowed chat, as MessageList requires; the
      // allowlist is then also handed to the provider, which narrows hits before limit/offset/total and
      // is how a plugin provider knows to refuse a restricted key.
      chatScope: ['chatId'],
      description:
        'Search persisted messages across every session and chat the API key may read. Returns ranked hits with a <mark>-highlighted snippet, chatId, sender and timestamp; resolve names with SessionGetChats or ContactFindOne. ' +
        `match=contains (the default) finds any part of a word, ignoring case and accents, and ranks the ${SEARCH_CONTAINS_WINDOW} most recently stored matches (whole words first, then newest), so total is at most ${SEARCH_CONTAINS_WINDOW}: narrow with more terms, chatId or dateTo to reach older ones. ` +
        'match=word finds whole words only. A key restricted to selected chats must pass chatId.',
      tier: 'read',
      requiredRole: ApiKeyRole.OPERATOR,
      inputSchema: z.object({
        q: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LENGTH).describe('Search term'),
        // Defaults to contains, unlike REST (word): an agent often knows only part of a word or types
        // it without accents, and contains finds everything word finds.
        match: z
          .enum(SEARCH_MATCH_MODES)
          .default('contains')
          .describe('contains: any part of a word (default); word: whole words only'),
        chatId: chatIdSchema.optional().describe('Restrict to a single chat JID'),
        from: z.string().optional().describe('Filter by sender phone or JID'),
        direction: z.enum(MessageDirection).optional(),
        dateFrom: z.number().optional().describe('Epoch-ms lower bound (inclusive)'),
        dateTo: z.number().optional().describe('Epoch-ms upper bound (inclusive)'),
        limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
        offset: z.number().int().min(0).max(SEARCH_OFFSET_MAX).optional(),
      }),
      handler: async (input, apiKey, chatScope) => {
        if (!search) throw new NotImplementedException('Search is disabled (SEARCH_ENABLED=false).');
        // Both scopes come from the authenticated key, never the input, exactly as SearchController
        // passes them: SearchService overwrites any caller-supplied scope at the provider boundary.
        return search.search(input, apiKey.allowedSessions ?? undefined, await chatScope?.idsForFilter(apiKey));
      },
    }),
  ];
}
