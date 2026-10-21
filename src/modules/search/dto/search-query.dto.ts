import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEnum, IsIn, IsInt, IsNumber, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { MessageDirection } from '../../message/entities/message.entity';
import type { MessageType } from '../../../engine/interfaces/whatsapp-engine.interface';
import { ToStrictNumber } from '../../../common/utils/strict-boolean';
import {
  SEARCH_CONTAINS_MIN_TERM_LENGTH,
  SEARCH_CONTAINS_WINDOW,
  SEARCH_MATCH_MODES,
  SEARCH_OFFSET_MAX,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_TERMS_MAX,
} from '../search.constants';
import type { SearchMatch } from '../search.types';

/**
 * Request shape for GET /search. Numeric fields are coerced from query-string strings via
 * `@Type(() => Number)` and then validated, so `?limit=abc` (Number('abc') → NaN) surfaces as a 400
 * from the global ValidationPipe, never reaching the provider as a NaN SQL param. The epoch-ms
 * bounds `dateFrom`/`dateTo` use `@IsNumber()`; `limit`/`offset` use `@IsInt()`, because they are
 * bound straight into `LIMIT ?`/`OFFSET ?` where better-sqlite3 rejects a fractional value with
 * SQLITE_MISMATCH: a fraction has to be a 400 here rather than a driver-level 500. `sessionIds` and
 * `chatIds` are intentionally absent: both scopes are injected by SearchService from the caller's
 * API-key allowedSessions/allowedChats (never user-supplied).
 */
export class SearchQueryDto {
  @ApiProperty({
    description: `Search term (required, non-empty, at most ${SEARCH_QUERY_MAX_LENGTH} characters and ${SEARCH_TERMS_MAX} words)`,
    maxLength: SEARCH_QUERY_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(SEARCH_QUERY_MAX_LENGTH)
  q!: string;

  @ApiPropertyOptional({
    enum: SEARCH_MATCH_MODES,
    default: 'word',
    description:
      '`word` (default) matches whole words. `contains` matches any part of a word, ignoring case and ' +
      `accents (\`voic\` finds "Invoice", \`cafe\` finds "Café"); it needs at least one term of ` +
      `${SEARCH_CONTAINS_MIN_TERM_LENGTH} or more characters, and on PostgreSQL the pg_trgm and unaccent extensions. ` +
      `It ranks the ${SEARCH_CONTAINS_WINDOW} most recently stored matches by match quality, so \`total\` is at most ` +
      `${SEARCH_CONTAINS_WINDOW}.`,
  })
  @IsOptional()
  @IsIn(SEARCH_MATCH_MODES)
  match?: SearchMatch;

  @ApiPropertyOptional({ description: 'Restrict to a single session' })
  @IsOptional()
  @IsString()
  sessionId?: string;

  @ApiPropertyOptional({
    description:
      "Restrict to a single chat id. A phone also matches the chat's other stored forms (the other user dialect and any lid that resolves to it).",
  })
  @IsOptional()
  @IsString()
  chatId?: string;

  @ApiPropertyOptional({
    description:
      "Sender filter. Matches `from` or a group message's `author`; a phone also matches any lid that resolves to it.",
  })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ enum: MessageDirection, description: 'incoming | outgoing' })
  @IsOptional()
  @IsEnum(MessageDirection)
  direction?: MessageDirection;

  @ApiPropertyOptional({ description: 'Message type filter (compared against stored messages.type)' })
  @IsOptional()
  @IsString()
  // `MessageType` is a string-literal union type alias, not a runtime enum, so @IsEnum can't validate
  // it. @IsString() accepts any string; the provider matches it against stored messages.type values.
  type?: MessageType;

  @ApiPropertyOptional({ description: 'Epoch-ms lower bound (inclusive)', type: Number })
  @ToStrictNumber()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  dateFrom?: number;

  @ApiPropertyOptional({ description: 'Epoch-ms upper bound (inclusive)', type: Number })
  @ToStrictNumber()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  dateTo?: number;

  @ApiPropertyOptional({ description: 'Max hits to return', type: 'integer', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({
    description: `Pagination offset, at most ${SEARCH_OFFSET_MAX}`,
    type: 'integer',
    minimum: 0,
    maximum: SEARCH_OFFSET_MAX,
  })
  @IsOptional()
  @ToStrictNumber()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  // Rejected rather than clamped: a clamped offset silently returns the page at the cap again.
  @Max(SEARCH_OFFSET_MAX)
  offset?: number;
}
