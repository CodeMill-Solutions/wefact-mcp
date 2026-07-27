import nock from 'nock';
import { WeFactClient } from '../../src/wefact-client.js';

/** Origin and path the client posts to, split the way nock wants them. */
export const ORIGIN = 'https://api.mijnwefact.nl';
export const PATH = '/v2/';

export const API_KEY = 'test-api-key';

/** A real client with a fake credentials map. The transport is genuinely axios. */
export function testClient(): WeFactClient {
  return new WeFactClient('test', new Map([['test', { apiKey: API_KEY }]]));
}

/** An interceptor for one call to the WeFact endpoint. */
export function api(): nock.Interceptor {
  return nock(ORIGIN).post(PATH);
}

/** A successful WeFact envelope. */
export function success(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { controller: 'settings', action: 'list', status: 'success', date: '2026-01-01T00:00:00+01:00', ...extra };
}

/** A WeFact error envelope. Note these arrive with HTTP 200. */
export function apiError(errors: string[]): Record<string, unknown> {
  return { controller: 'settings', action: 'list', status: 'error', errors };
}

/** Rate-limit headers as WeFact spells them, with resets `inSeconds` from now. */
export function rateLimitHeaders(remainingMinute: number, inSeconds = 30, remainingHour = 4000) {
  const reset = Math.floor(Date.now() / 1000) + inSeconds;
  return {
    'api-ratelimit-remaining-minute': String(remainingMinute),
    'api-ratelimit-remaining-hour': String(remainingHour),
    'api-ratelimit-reset-minute': String(reset),
    'api-ratelimit-reset-hour': String(reset + 600),
  };
}
