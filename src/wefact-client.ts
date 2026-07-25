import axios, { AxiosError, type AxiosResponse } from 'axios';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ── WeFact API v2 ─────────────────────────────────────────────────────────────
//
// Source: https://developer.wefact.com. Behaviour below verified against a live
// account on 2026-07-25; several points contradict the published docs.
//
// Transport model (much simpler than a REST API — there is only one URL):
//   POST https://api.mijnwefact.nl/v2/
//   body: { api_key, controller, action, ...params }   (JSON, verified working)
//
// There is no session exchange and no bearer token: the API key travels on every
// request. One key belongs to exactly one administration, so multi-administration
// support is a map of `administration label → { apiKey }`.
//
// Two things make this API unusual and drive most of the code below:
//
//   1. HTTP status is ALWAYS 200, even for authentication failures and
//      not-found errors. Success is signalled by the body's `status` field, and
//      failures arrive as `errors: string[]` of Dutch prose with no machine
//      codes. The only exception is a rate-limit ban, which is a real HTTP 403.
//
//   2. WeFact answers abuse with an IP-level firewall ban rather than a soft
//      429, and failed authentication attempts count against both the request
//      budget and a separate daily cap. That makes naive retrying actively
//      harmful, so this client throttles proactively and refuses to retry the
//      two error classes where retrying makes things worse.

export const WEFACT_API_URL = 'https://api.mijnwefact.nl/v2/';

const REQUEST_TIMEOUT_MS = 30_000;

/** WeFact's own default and maximum page size for `list` actions. */
const WEFACT_MAX_PAGE_SIZE = 1000;

/**
 * Rows fetched per page by `paginate()`. Deliberately below WeFact's 1000: list
 * rows are wide, and 1000 of them in a single tool result crowds out an agent's
 * context for no benefit.
 */
const DEFAULT_PAGE_SIZE = 500;

/** Default cap on rows returned across all pages of one list call. */
const DEFAULT_MAX_ITEMS = 1000;

/** Stop and wait when fewer than this many calls remain in the current minute. */
const DEFAULT_RATE_LIMIT_RESERVE = 5;

/** Retries for transient failures only (429/5xx/dropped connections). */
const DEFAULT_MAX_RETRIES = 2;

/** Never sleep longer than one minute window + slack; a longer wait means a stale snapshot. */
const MAX_THROTTLE_SLEEP_MS = 65_000;

// ── Credentials file loading ────────────────────────────────────────────────
//
// Resolve which JSON file holds the administration → credentials map, with the
// same precedence the sibling MCP servers use:
//   1. WEFACT_CREDENTIALS_FILE environment variable (explicit path)
//   2. ~/.wefact/credentials.json  (default user-level location)
//   3. ./credentials.json  (local fallback for development)

export interface AdministrationCredentials {
  /** Secret API key created under "Instellingen → API" in the administration. */
  apiKey: string;
}

export interface LoadedCredentials {
  /** Absolute path that was read from. */
  path: string;
  /** Map of administration label → credentials. Empty if the file did not exist. */
  map: Map<string, AdministrationCredentials>;
  /** True when the resolved file existed and was parsed. */
  found: boolean;
}

export function resolveCredentialsFilePath(explicitPath?: string): string {
  if (explicitPath) return explicitPath;
  if (process.env['WEFACT_CREDENTIALS_FILE']) return process.env['WEFACT_CREDENTIALS_FILE'];
  const userPath = join(homedir(), '.wefact', 'credentials.json');
  if (existsSync(userPath)) return userPath;
  return 'credentials.json';
}

/**
 * Read the credentials file. Both `api_key` (WeFact's own vocabulary) and
 * `apiKey` (the convention in the sibling servers) are accepted, because
 * whichever one we picked, somebody would write the other.
 */
export function loadCredentialsFile(explicitPath?: string): LoadedCredentials {
  const path = resolveCredentialsFilePath(explicitPath);
  const map = new Map<string, AdministrationCredentials>();
  if (!existsSync(path)) {
    return { path, map, found: false };
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, Record<string, string>>;
  for (const [name, creds] of Object.entries(raw)) {
    if (!name || !creds) continue;
    const apiKey = creds['apiKey'] ?? creds['api_key'];
    if (!apiKey) continue;
    map.set(name, { apiKey });
  }
  return { path, map, found: true };
}

/** Fallback administration label used when only a bare API key is provided. */
export const DEFAULT_ADMINISTRATION_LABEL = 'default';

export interface ResolvedCredentials {
  /** Administration label to use when a tool omits `administration`. */
  defaultAdministration: string;
  /** Merged map of administration label → credentials (file + env). */
  map: Map<string, AdministrationCredentials>;
  /** Path the credentials file was resolved to. */
  credentialsFilePath: string;
  /** True when that file existed and was parsed. */
  fileFound: boolean;
}

/**
 * Resolve the full credentials picture from the environment + credentials file,
 * applying the precedence and fallbacks shared by the server and the probe
 * scripts:
 *
 *   1. Load `credentials.json` (label → { apiKey }).
 *   2. If `WEFACT_API_KEY` is set, register it under `WEFACT_ADMINISTRATION` —
 *      or, when that label is empty, under `"default"`. The key alone is enough
 *      to authenticate; the label is only a local selector.
 *   3. The default administration is the env label (if any), otherwise the
 *      first entry in the file.
 */
export function resolveCredentials(): ResolvedCredentials {
  const loaded = loadCredentialsFile();
  const map = loaded.map;

  const envKey = process.env['WEFACT_API_KEY'] ?? '';
  let defaultAdministration = process.env['WEFACT_ADMINISTRATION'] ?? '';

  if (envKey) {
    const label = defaultAdministration || DEFAULT_ADMINISTRATION_LABEL;
    if (!map.has(label)) {
      map.set(label, { apiKey: envKey });
    }
    defaultAdministration = label;
  }

  if (!defaultAdministration && map.size > 0) {
    defaultAdministration = map.keys().next().value ?? '';
  }

  return { defaultAdministration, map, credentialsFilePath: loaded.path, fileFound: loaded.found };
}

/**
 * Diff returned by `WeFactClient.reloadCredentials` so callers can report what
 * changed — used by the `reload_credentials` MCP tool.
 */
export interface CredentialsReloadDiff {
  added: string[];
  updated: string[];
  removed: string[];
  total: number;
}

// ── Rate limiting ───────────────────────────────────────────────────────────

/**
 * Snapshot of the four `API-RateLimit-*` headers WeFact returns on every
 * response, including error responses. The documented ceilings (200/min,
 * 3600/hour) are stale — a live account reports 500/min and 5000/hour.
 */
export interface RateLimitSnapshot {
  remainingMinute?: number;
  remainingHour?: number;
  /** Unix seconds (UTC) at which the minute / hour counter resets. */
  resetMinute?: number;
  resetHour?: number;
  /** The same resets as ISO strings, for humans and error messages. */
  resetMinuteAt?: string;
  resetHourAt?: string;
  observedAt: string;
}

function parseRateLimit(response: AxiosResponse | undefined): RateLimitSnapshot | undefined {
  const headers = response?.headers as Record<string, string | undefined> | undefined;
  if (!headers) return undefined;

  const num = (name: string): number | undefined => {
    const raw = headers[name];
    if (raw === undefined || raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const iso = (seconds: number | undefined): string | undefined =>
    seconds === undefined ? undefined : new Date(seconds * 1000).toISOString();

  const resetMinute = num('api-ratelimit-reset-minute');
  const resetHour = num('api-ratelimit-reset-hour');
  const snapshot: RateLimitSnapshot = {
    remainingMinute: num('api-ratelimit-remaining-minute'),
    remainingHour: num('api-ratelimit-remaining-hour'),
    resetMinute,
    resetHour,
    resetMinuteAt: iso(resetMinute),
    resetHourAt: iso(resetHour),
    observedAt: new Date().toISOString(),
  };

  // Nothing parsed — don't cache an empty snapshot over a useful one.
  if (snapshot.remainingMinute === undefined && snapshot.remainingHour === undefined) return undefined;
  return snapshot;
}

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Why a call failed. The distinction matters operationally: `firewalled` and
 * `auth` must never be retried automatically, and the three operator-fixable
 * kinds carry a remediation hint in the message.
 */
export type WeFactErrorKind =
  'api' | 'ip-not-whitelisted' | 'firewalled' | 'auth' | 'invalid-endpoint' | 'http' | 'network';

export class WeFactApiError extends Error {
  readonly kind: WeFactErrorKind;
  readonly controller: string;
  readonly action: string;
  /** The raw Dutch error strings from the response body, verbatim. */
  readonly errors: string[];
  readonly warnings: string[];
  readonly httpStatus: number;
  readonly rateLimit: RateLimitSnapshot | undefined;

  constructor(init: {
    message: string;
    kind: WeFactErrorKind;
    controller: string;
    action: string;
    errors?: string[];
    warnings?: string[];
    httpStatus?: number;
    rateLimit?: RateLimitSnapshot;
  }) {
    super(init.message);
    this.name = 'WeFactApiError';
    this.kind = init.kind;
    this.controller = init.controller;
    this.action = init.action;
    this.errors = init.errors ?? [];
    this.warnings = init.warnings ?? [];
    this.httpStatus = init.httpStatus ?? 0;
    this.rateLimit = init.rateLimit;
  }

  /** True for the two kinds where retrying makes the situation worse. */
  get isRetryHarmful(): boolean {
    return this.kind === 'firewalled' || this.kind === 'auth';
  }
}

/**
 * Classify a WeFact failure from its body text and HTTP status. WeFact returns
 * no machine-readable codes, so this matches on the message strings — all of
 * which were captured from the live API rather than guessed.
 */
function classify(errors: string[], httpStatus: number): { kind: WeFactErrorKind; hint?: string } {
  const joined = errors.join(' ');

  if (httpStatus === 403 || /currently in firewall/i.test(joined)) {
    return {
      kind: 'firewalled',
      hint:
        'Your IP is banned by the rate limiter. Limits are ~500 calls/minute and ~5000/hour per IP, ' +
        'and failed authentication attempts count too. Wait for the reset — do NOT retry in a loop, ' +
        'because further calls extend the ban.',
    };
  }
  if (/has no access to API/i.test(joined)) {
    return {
      kind: 'ip-not-whitelisted',
      hint:
        "Whitelist this machine's public IP under Instellingen → API in WeFact. " +
        'Run `npm run whoami` to print the IP that needs whitelisting.',
    };
  }
  if (/API[- ]?sleutel|api[_ ]?key|authenticat/i.test(joined)) {
    return {
      kind: 'auth',
      hint:
        'Check WEFACT_API_KEY or ~/.wefact/credentials.json. Failed authentication attempts consume the ' +
        'rate-limit budget and there is a separate daily cap, so fix the key rather than retrying.',
    };
  }
  if (/^Invalid (action|controller)$/i.test(joined)) {
    return {
      kind: 'invalid-endpoint',
      hint:
        'This controller/action pair does not exist in WeFact. The mapping lives in src/wefact-endpoints.ts; ' +
        'note that `sortlines` is on the parent controller while line add/delete is on the line controller.',
    };
  }
  if (httpStatus >= 400) return { kind: 'http' };
  return { kind: 'api' };
}

/**
 * Build the thrown Error for a failed call. WeFact's `errors[]` is Dutch prose
 * with no codes, so it *is* the diagnostic payload — it is joined in full and
 * never truncated.
 */
function buildApiError(args: {
  controller: string;
  action: string;
  errors: string[];
  warnings?: string[];
  httpStatus: number;
  rateLimit?: RateLimitSnapshot;
}): WeFactApiError {
  const { kind, hint } = classify(args.errors, args.httpStatus);
  const detail = args.errors.length > 0 ? args.errors.join('; ') : 'unknown error';
  const hintPart = hint ? ` — ${hint}` : '';
  const resetPart =
    kind === 'firewalled' && args.rateLimit?.resetHourAt ? ` Rate limit resets at ${args.rateLimit.resetHourAt}.` : '';

  return new WeFactApiError({
    message:
      `WeFact API error during ${args.controller}/${args.action} — ${detail}${hintPart}${resetPart} ` +
      `(HTTP ${args.httpStatus})`,
    kind,
    controller: args.controller,
    action: args.action,
    errors: args.errors,
    warnings: args.warnings,
    httpStatus: args.httpStatus,
    rateLimit: args.rateLimit,
  });
}

// ── Request/response shapes ─────────────────────────────────────────────────

export interface WeFactRequestOptions {
  /** Administration label selecting which API key to use. */
  administration?: string;
  controller: string;
  action: string;
  /** Action parameters; `undefined` values are dropped, `0`/`''`/`false` are kept. */
  params?: Record<string, unknown>;
  /** Return the envelope untouched instead of throwing when `status !== 'success'`. */
  raw?: boolean;
}

/**
 * The envelope every WeFact response shares. `success` is overloaded: usually an
 * array of Dutch confirmation strings, but `attachment/download` returns the file
 * as a positional array under the same key.
 */
export interface WeFactEnvelope {
  controller: string;
  action: string;
  status: 'success' | 'error';
  date?: string;
  errors?: string[];
  warning?: string[];
  success?: unknown;
  totalresults?: number;
  currentresults?: number;
  offset?: number;
  filters?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PaginateOptions {
  administration?: string;
  /** Defaults to `list`. */
  action?: string;
  params?: Record<string, unknown>;
  /**
   * Envelope key holding the rows, e.g. `debtors`. Required rather than sniffed:
   * the envelope also carries `filters`, `success` and `warning`, so a
   * "first array value" heuristic would grab the wrong thing.
   */
  itemsKey: string;
  pageSize?: number;
  maxItems?: number;
}

export interface PaginateResult<T> {
  items: T[];
  /** Total rows matching the filter, per WeFact's `totalresults`. */
  totalResults: number;
  fetched: number;
  /** True when `maxItems` cut the result short — the agent should narrow its filter. */
  truncated: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Drop `undefined` values from a params object.
 *
 * Note this drops ONLY `undefined`, unlike the equivalent in the sibling
 * e-Boekhouden server which also drops empty strings. WeFact uses `Status: 0`
 * and `InvoiceMethod: ''` as meaningful values, so anything the caller set
 * explicitly must survive.
 */
function dropUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** ±25% jitter, so concurrent servers sharing an IP don't retry in lockstep. */
function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function isTransient(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const ax = err as AxiosError;
  const status = ax.response?.status;
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND'].includes(ax.code ?? '');
}

// ── Client ──────────────────────────────────────────────────────────────────

/**
 * WeFactClient — owns the credentials map and the per-administration rate-limit
 * state, and exposes the single `request()` method every MCP tool goes through.
 *
 * Unlike the sibling e-Boekhouden client there is no session cache and no 401
 * retry: the API key authenticates each call directly.
 */
export class WeFactClient {
  private readonly defaultAdministration: string;
  private readonly credentialsMap: Map<string, AdministrationCredentials>;
  private readonly rateLimits = new Map<string, RateLimitSnapshot>();

  constructor(defaultAdministration: string, credentialsMap?: Map<string, AdministrationCredentials>) {
    this.defaultAdministration = defaultAdministration;
    this.credentialsMap = credentialsMap ?? new Map();
  }

  // ── Introspection ──────────────────────────────────────────────────────────

  /** Default administration label from the environment. */
  get defaultAdministrationName(): string {
    return this.defaultAdministration;
  }

  /** Number of administrations with configured credentials. */
  get credentialsCount(): number {
    return this.credentialsMap.size;
  }

  /** List of all administration labels that currently have credentials. */
  listAdministrationNames(): string[] {
    return Array.from(this.credentialsMap.keys());
  }

  /** Last observed rate-limit headroom for an administration, if any call has been made. */
  getRateLimit(administration?: string): RateLimitSnapshot | undefined {
    const name = administration ?? this.defaultAdministration;
    return this.rateLimits.get(name);
  }

  /** Resolve which administration to use for a call (falls back to the default). */
  private resolveAdministration(administration?: string): string {
    const name = administration ?? this.defaultAdministration;
    if (!name) {
      throw new Error(
        'No administration provided and WEFACT_ADMINISTRATION is not set. ' +
          'Pass `administration` explicitly or set a default in the environment.',
      );
    }
    return name;
  }

  private getApiKey(administration: string): string {
    const creds = this.credentialsMap.get(administration);
    if (!creds) {
      throw new Error(
        `No WeFact credentials configured for administration "${administration}". ` +
          'Add an entry to credentials.json or set WEFACT_API_KEY.',
      );
    }
    return creds.apiKey;
  }

  // ── Credentials map reload ───────────────────────────────────────────────

  /**
   * Replace the in-memory `credentialsMap` with `next`, in place, and return a
   * diff for the `reload_credentials` MCP tool. Rate-limit snapshots for removed
   * administrations are dropped; the rest stay, since the limit is per IP rather
   * than per key and remains just as true.
   */
  reloadCredentials(next: Map<string, AdministrationCredentials>): CredentialsReloadDiff {
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];

    for (const [name, previous] of this.credentialsMap) {
      const incoming = next.get(name);
      if (incoming === undefined) {
        removed.push(name);
        this.rateLimits.delete(name);
      } else if (incoming.apiKey !== previous.apiKey) {
        updated.push(name);
      }
    }

    for (const name of next.keys()) {
      if (!this.credentialsMap.has(name)) added.push(name);
    }

    this.credentialsMap.clear();
    for (const [name, creds] of next) {
      this.credentialsMap.set(name, creds);
    }

    return { added, updated, removed, total: this.credentialsMap.size };
  }

  // ── Throttling ───────────────────────────────────────────────────────────

  /**
   * Wait out the current minute window when we are close to the per-IP limit.
   *
   * This is the mechanism that actually protects us: WeFact answers a breach
   * with an IP ban, not a soft 429, so the cost of one avoidable sleep is far
   * below the cost of being locked out. The snapshot is refreshed by every
   * response, so a stale reading self-corrects on the next call.
   */
  private async throttle(administration: string): Promise<void> {
    const reserve = envInt('WEFACT_RATE_LIMIT_RESERVE', DEFAULT_RATE_LIMIT_RESERVE);
    const snapshot = this.rateLimits.get(administration);
    if (!snapshot || snapshot.remainingMinute === undefined) return;
    if (snapshot.remainingMinute > reserve) return;
    if (snapshot.resetMinute === undefined) return;

    const waitMs = snapshot.resetMinute * 1000 - Date.now() + 250;
    if (waitMs <= 0 || waitMs > MAX_THROTTLE_SLEEP_MS) return;

    process.stderr.write(
      `[wefact-mcp] Rate-limit reserve reached (${snapshot.remainingMinute} calls left this minute) — ` +
        `waiting ${Math.ceil(waitMs / 1000)}s for the window to reset.\n`,
    );
    await sleep(waitMs);
  }

  // ── Core request ─────────────────────────────────────────────────────────

  /**
   * Execute one WeFact API call and return the parsed envelope.
   *
   * Throws a `WeFactApiError` when the body reports `status: "error"` — the HTTP
   * status is 200 in that case, so callers must never branch on it themselves.
   * Pass `raw: true` to receive the error envelope instead of an exception.
   */
  async request<T extends WeFactEnvelope = WeFactEnvelope>(options: WeFactRequestOptions): Promise<T> {
    const { controller, action, params, raw } = options;
    const name = this.resolveAdministration(options.administration);
    const apiKey = this.getApiKey(name);

    const body = {
      api_key: apiKey,
      controller,
      action,
      ...dropUndefined(params ?? {}),
    };

    const useForm = (process.env['WEFACT_TRANSPORT'] ?? '').trim().toLowerCase() === 'form';
    const maxRetries = envInt('WEFACT_MAX_RETRIES', DEFAULT_MAX_RETRIES);

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await this.throttle(name);

      let response: AxiosResponse<T>;
      try {
        response = await axios.request<T>({
          method: 'POST',
          url: WEFACT_API_URL,
          data: useForm ? encodeForm(body) : body,
          headers: {
            'Content-Type': useForm ? 'application/x-www-form-urlencoded' : 'application/json',
            Accept: 'application/json',
          },
          timeout: REQUEST_TIMEOUT_MS,
          // A rate-limit ban is a real 403 with a JSON body worth reading, so
          // let every status through and classify it ourselves.
          validateStatus: () => true,
        });
      } catch (err) {
        if (isTransient(err) && attempt < maxRetries) {
          attempt += 1;
          await sleep(jitter(1000 * 4 ** (attempt - 1)));
          continue;
        }
        const ax = axios.isAxiosError(err) ? (err as AxiosError) : undefined;
        throw new WeFactApiError({
          message: `WeFact network error during ${controller}/${action}: ${ax?.message ?? String(err)}`,
          kind: 'network',
          controller,
          action,
        });
      }

      const snapshot = parseRateLimit(response);
      if (snapshot) this.rateLimits.set(name, snapshot);

      const envelope = response.data;
      const httpStatus = response.status;

      // Retry genuinely transient HTTP failures, but never a 403: that is the
      // firewall ban, and retrying extends it.
      if ((httpStatus === 429 || httpStatus >= 500) && attempt < maxRetries) {
        attempt += 1;
        await sleep(jitter(1000 * 4 ** (attempt - 1)));
        continue;
      }

      if (!envelope || typeof envelope !== 'object') {
        throw new WeFactApiError({
          message:
            `WeFact API error during ${controller}/${action} — the response was not JSON ` +
            `(HTTP ${httpStatus}). This usually means a proxy or firewall intercepted the call.`,
          kind: 'http',
          controller,
          action,
          httpStatus,
          rateLimit: snapshot,
        });
      }

      if (raw) return envelope;

      if (envelope.status !== 'success') {
        throw buildApiError({
          controller,
          action,
          errors: Array.isArray(envelope.errors) ? envelope.errors : [],
          warnings: Array.isArray(envelope.warning) ? envelope.warning : [],
          httpStatus,
          rateLimit: snapshot,
        });
      }

      return envelope;
    }
  }

  /**
   * Fetch every page of a `list` action and return the concatenated rows.
   *
   * Driven by the envelope's `totalresults` rather than a "short page" guess, so
   * there is no wasted trailing request when the last page happens to be exactly
   * `pageSize` long. Note that WeFact omits the rows key entirely when a list is
   * empty — it does not return `[]` — hence the explicit fallback.
   */
  async paginate<T = unknown>(controller: string, options: PaginateOptions): Promise<PaginateResult<T>> {
    const action = options.action ?? 'list';
    const pageSize = Math.min(options.pageSize ?? envInt('WEFACT_PAGE_SIZE', DEFAULT_PAGE_SIZE), WEFACT_MAX_PAGE_SIZE);
    const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;

    const items: T[] = [];
    let totalResults = 0;
    let offset = 0;

    // Belt-and-braces bound: even if `totalresults` is wrong we cannot spin.
    const maxPages = Math.ceil(maxItems / pageSize) + 2;

    for (let page = 0; page < maxPages; page += 1) {
      const envelope = await this.request({
        administration: options.administration,
        controller,
        action,
        params: { ...options.params, offset, limit: pageSize },
      });

      totalResults = typeof envelope.totalresults === 'number' ? envelope.totalresults : items.length;

      const rows = envelope[options.itemsKey];
      const pageItems: T[] = Array.isArray(rows) ? (rows as T[]) : [];
      items.push(...pageItems);

      // An empty page is the only reliable stop signal if `totalresults` lies.
      if (pageItems.length === 0) break;
      if (items.length >= Math.min(totalResults, maxItems)) break;

      offset += pageSize;
    }

    const capped = items.slice(0, maxItems);
    return {
      items: capped,
      totalResults,
      fetched: capped.length,
      truncated: capped.length < totalResults,
    };
  }
}

/**
 * Serialise a request body as `application/x-www-form-urlencoded` for the
 * `WEFACT_TRANSPORT=form` escape hatch, using PHP's bracket notation for nested
 * values so `InvoiceLines[0][PriceExcl]=10` arrives the way WeFact's own PHP
 * sample client sends it.
 */
function encodeForm(body: Record<string, unknown>): string {
  const parts: string[] = [];

  const walk = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(`${key}[${index}]`, entry));
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(`${key}[${k}]`, v);
      }
      return;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };

  for (const [k, v] of Object.entries(body)) walk(k, v);
  return parts.join('&');
}
