import {
  WeFactClient,
  type PaginateOptions,
  type PaginateResult,
  type WeFactEnvelope,
  type WeFactRequestOptions,
} from '../../src/wefact-client.js';

/**
 * A `WeFactClient` that records what a tool asked for and never reaches the
 * network.
 *
 * It **subclasses** rather than structurally faking, because `WeFactClient`
 * declares private members and is therefore nominally typed: an object literal
 * implementing only `request`/`paginate` is not assignable to it, and a cast
 * would silently keep compiling if `request`'s signature ever changed — exactly
 * the drift these tests exist to catch. A subclass breaks at compile time
 * instead.
 *
 * The client's own behaviour (transport, retries, throttling, pagination) is
 * covered separately in test/wefact-client/ against a real client and nock.
 * Here it is deliberately inert, so tool tests assert on the *request* a tool
 * builds rather than on HTTP.
 */

export interface RecordedCall {
  kind: 'request' | 'paginate';
  administration?: string | undefined;
  controller: string;
  action: string;
  params?: Record<string, unknown> | undefined;
  itemsKey?: string | undefined;
}

/** What the next call resolves with, or an Error it should throw. */
export type QueuedReply = Partial<WeFactEnvelope> | Error;

export class RecordingClient extends WeFactClient {
  readonly calls: RecordedCall[] = [];
  private readonly queue: QueuedReply[] = [];

  constructor(administrations: Record<string, string> = { test: 'test-api-key' }) {
    super('test', new Map(Object.entries(administrations).map(([label, apiKey]) => [label, { apiKey }])));
  }

  /** Queue the envelope(s) the next call(s) resolve with. */
  reply(...next: QueuedReply[]): this {
    this.queue.push(...next);
    return this;
  }

  /**
   * Forget recorded calls and queued replies. Call this in `beforeEach` when a
   * harness is shared across tests, so `only` keeps meaning "the call this test
   * made" rather than "everything this file has done so far".
   */
  reset(): this {
    this.calls.length = 0;
    this.queue.length = 0;
    return this;
  }

  /**
   * The single call that was made. Throws when there was not exactly one, so a
   * test cannot pass because a tool made no call at all — the failure mode that
   * matters most when asserting that a blocked write stayed blocked.
   */
  get only(): RecordedCall {
    if (this.calls.length !== 1) {
      throw new Error(`Expected exactly 1 client call, got ${this.calls.length}: ${JSON.stringify(this.calls)}`);
    }
    return this.calls[0]!;
  }

  /** `controller/action` of the single call, for terse routing assertions. */
  get route(): string {
    const { controller, action } = this.only;
    return `${controller}/${action}`;
  }

  /** Params of the single call. */
  get params(): Record<string, unknown> {
    return this.only.params ?? {};
  }

  private take(): Partial<WeFactEnvelope> {
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    return next ?? {};
  }

  override async request<T extends WeFactEnvelope = WeFactEnvelope>(options: WeFactRequestOptions): Promise<T> {
    this.calls.push({
      kind: 'request',
      administration: options.administration,
      controller: options.controller,
      action: options.action,
      params: options.params,
    });
    const next = this.take();
    return {
      controller: options.controller,
      action: options.action,
      status: 'success',
      ...next,
    } as T;
  }

  override async paginate<T = unknown>(controller: string, options: PaginateOptions): Promise<PaginateResult<T>> {
    this.calls.push({
      kind: 'paginate',
      administration: options.administration,
      controller,
      action: options.action ?? 'list',
      params: options.params,
      itemsKey: options.itemsKey,
    });
    const next = this.take();
    const rows = next[options.itemsKey];
    const items: T[] = Array.isArray(rows) ? (rows as T[]) : [];
    return {
      items,
      totalResults: typeof next['totalresults'] === 'number' ? (next['totalresults'] as number) : items.length,
      fetched: items.length,
      truncated: false,
    };
  }
}
