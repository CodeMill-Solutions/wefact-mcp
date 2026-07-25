import { ok, type ToolTextResult } from './result.js';

/**
 * Shared helpers for the gated write tools. Keeping the safety posture (env gate
 * + dry-run) in one place means every write tool behaves identically and a
 * change is made once.
 *
 * WeFact has a second class of danger the sibling servers do not: four actions
 * send real email to a customer, and `invoice/sendbyemail` additionally
 * finalises a draft and burns an invoice number. Those sit behind a second env
 * gate (`WEFACT_ALLOW_SEND`) so enabling ordinary writes never implies
 * permission to contact customers.
 */

/**
 * Whether write operations are permitted. Writes are refused unless
 * `WEFACT_ALLOW_WRITES` is set to a truthy value, so the default posture stays
 * read-only even though the write tools are registered.
 */
export function writesEnabled(): boolean {
  const v = (process.env['WEFACT_ALLOW_WRITES'] ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/**
 * Whether this server may send email to customers. Required *in addition to*
 * `writesEnabled()` for the handful of outward-facing tools.
 */
export function sendEnabled(): boolean {
  const v = (process.env['WEFACT_ALLOW_SEND'] ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/** Drop undefined values so we send a clean request body. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Standard refusal message when writes are disabled. */
export const WRITES_DISABLED_REASON =
  'Writes are disabled. Set WEFACT_ALLOW_WRITES=true in the server environment to enable them.';

/** Standard refusal message when outbound email is disabled. */
export const SEND_DISABLED_REASON =
  'Outbound email is disabled. Set WEFACT_ALLOW_SEND=true (in addition to WEFACT_ALLOW_WRITES) to let this ' +
  'server send email to your customers.';

export interface GatedWriteOptions {
  /** When false/omitted, return a dry-run preview instead of writing. */
  confirm?: boolean;
  /** Result flag name, chosen to read naturally for the operation. */
  statusKey?: 'written' | 'created' | 'updated' | 'deleted' | 'sent';
  /** Key under which the would-be request body is returned in preview responses. */
  plannedKey: string;
  /** Key under which the result is returned on success. */
  resultKey: string;
  /** The request body to preview / send. */
  body: Record<string, unknown>;
  /** Performs the actual write and returns the result. */
  execute: () => Promise<unknown>;
  /** Extra fields merged into every response (e.g. resolved defaults). */
  extra?: Record<string, unknown>;
  /** Requires WEFACT_ALLOW_SEND on top of WEFACT_ALLOW_WRITES. */
  requiresSend?: boolean;
  /**
   * One sentence naming the real-world consequence, echoed in the dry-run so the
   * preview an agent shows a user actually states what is about to happen.
   */
  consequence?: string;
}

/**
 * Apply the safety guards shared by every write tool:
 *   1. env gate — refuse unless WEFACT_ALLOW_WRITES is truthy;
 *   2. send gate — for outward-facing tools, also require WEFACT_ALLOW_SEND;
 *   3. dry-run — only write when `confirm` is true, otherwise echo the body.
 *
 * Build the request `body` before calling this; for tools that resolve values
 * over the network, gate that work on `writesEnabled()` so a blocked call does
 * no needless requests.
 */
export async function gatedWrite(opts: GatedWriteOptions): Promise<ToolTextResult> {
  const statusKey = opts.statusKey ?? 'written';
  const extra = opts.extra ?? {};
  const consequence = opts.consequence ? { consequence: opts.consequence, irreversible: true } : {};

  if (!writesEnabled()) {
    return ok({
      [statusKey]: false,
      blocked: true,
      reason: WRITES_DISABLED_REASON,
      ...consequence,
      ...extra,
      [opts.plannedKey]: opts.body,
    });
  }

  if (opts.requiresSend && !sendEnabled()) {
    return ok({
      [statusKey]: false,
      blocked: true,
      reason: SEND_DISABLED_REASON,
      ...consequence,
      ...extra,
      [opts.plannedKey]: opts.body,
    });
  }

  if (!opts.confirm) {
    return ok({
      [statusKey]: false,
      dryRun: true,
      message: `Dry-run: nothing was ${statusKey === 'sent' ? 'sent' : 'written'}. Re-run with confirm: true to proceed.`,
      ...consequence,
      ...extra,
      [opts.plannedKey]: opts.body,
    });
  }

  const result = await opts.execute();
  return ok({ [statusKey]: true, ...extra, [opts.resultKey]: result });
}

/**
 * Build the id-or-code selector that ~30 WeFact actions accept, e.g.
 * `{ Identifier: 12 }` or `{ InvoiceCode: 'F2024-0001' }`. Throws a self-
 * explaining error when neither was supplied, since WeFact's own message for
 * that case is unhelpful.
 */
export function buildSelector(
  codeField: string,
  input: { identifier?: number; code?: string },
  entity: string,
): Record<string, unknown> {
  if (input.identifier !== undefined) return { Identifier: input.identifier };
  if (input.code !== undefined && input.code !== '') return { [codeField]: input.code };
  throw new Error(`Provide either \`identifier\` (numeric ${entity} Identifier) or \`code\` (${codeField}).`);
}
