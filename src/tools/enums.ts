/**
 * WeFact's coded values, and the helper that makes them legible in tool output.
 *
 * WeFact returns bare codes (`Status: "2"`, `Periodic: "k"`) with no labels, and
 * the scales are not shared between entities — invoice status `1` does not
 * exist while purchase-invoice status `1` means unpaid. Every list/show tool
 * therefore annotates its rows with a `<field>Label` so an agent never has to
 * remember a mapping.
 *
 * Values are keyed as strings throughout: WeFact serialises numeric enums as
 * strings in some responses and as numbers in others.
 *
 * Source: https://developer.wefact.com/variable-list
 */

/**
 * Sales invoice status. Note there is no 1, 5, 6 or 7.
 *
 * Status 9 is "vervallen", which in Dutch covers both "expired" and "voided".
 * Observed against the live API: crediting a paid invoice moves the ORIGINAL to
 * 9, so in practice it means the invoice no longer stands — either because it
 * was credited or because it lapsed. The label says both rather than picking the
 * reading that happens to be wrong half the time.
 */
export const INVOICE_STATUS_LABELS: Record<string, string> = {
  '0': 'draft',
  '2': 'sent',
  '3': 'partly paid',
  '4': 'paid',
  '8': 'credit invoice',
  '9': 'voided or expired',
};

/** Secondary invoice state, orthogonal to Status. */
export const INVOICE_SUBSTATUS_LABELS: Record<string, string> = {
  '': 'active',
  BLOCKED: 'blocked (draft will not be sent or extended)',
  PAUSED: 'payment process paused',
};

/** Price quote status. */
export const PRICEQUOTE_STATUS_LABELS: Record<string, string> = {
  '0': 'concept',
  '2': 'sent',
  '3': 'accepted',
  '4': 'invoice created',
  '8': 'declined',
};

/** Purchase invoice status — a DIFFERENT scale from sales invoices. */
export const CREDITINVOICE_STATUS_LABELS: Record<string, string> = {
  '1': 'unpaid',
  '2': 'partly paid',
  '3': 'paid',
  '8': 'credit invoice',
};

/** Recurrence unit for subscriptions and periodic invoice lines. */
export const PERIODIC_LABELS: Record<string, string> = {
  '': 'no subscription',
  d: 'day',
  w: 'week',
  m: 'month',
  k: 'quarter',
  h: 'half year',
  j: 'year',
  t: 'two years',
};

/** How a document is delivered. */
export const INVOICE_METHOD_LABELS: Record<string, string> = {
  '0': 'email',
  '1': 'post',
  '3': 'email and post',
  '5': 'Peppol',
  '': "debtor's own preference",
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  wire: 'bank transfer',
  cash: 'cash',
  card: 'PIN / card',
  auth: 'direct debit',
  accounting: 'via bookkeeping package',
  various: 'various',
  paypal: 'PayPal',
  ideal: 'iDEAL',
  qrcode: 'QR code',
  other: 'other online payment method',
};

export const BANK_TRANSACTION_STATUS_LABELS: Record<string, string> = {
  unmatched: 'unmatched',
  matched: 'matched',
  ignored: 'ignored',
  pending: 'pending',
  proposed_match: 'match proposed',
  skipped: 'skipped',
};

// ── Value lists used directly in zod enums ──────────────────────────────────

export const PAYMENT_METHODS = [
  'wire',
  'cash',
  'card',
  'auth',
  'accounting',
  'various',
  'paypal',
  'ideal',
  'qrcode',
  'other',
] as const;

export const TASK_STATUSES = ['open', 'in_progress', 'completed'] as const;

export const COMMUNICATION_METHODS = ['phone', 'whatsapp', 'email', 'post', 'in_person'] as const;

/** Salutation. `u` (unknown) was added in API 2.4.7. */
export const SEX_VALUES = ['m', 'f', 'd', 'fam', 'u'] as const;

export const PERIODIC_VALUES = ['d', 'w', 'm', 'k', 'h', 'j', 't'] as const;

/** Entities a CRM task or interaction can be attached to. `unlinked` is tasks-only. */
export const CRM_REFERENCE_TYPES = [
  'debtor',
  'creditor',
  'invoice',
  'pricequote',
  'creditinvoice',
  'unprocessed_creditinvoice',
  'subscription',
] as const;

export const BANK_TRANSACTION_STATUSES = [
  'unmatched',
  'ignored',
  'matched',
  'pending',
  'proposed_match',
  'skipped',
] as const;

export const BANK_TRANSACTION_TYPES = ['batch', 'deposit', 'withdrawal', 'reversal'] as const;

// ── Friendly filter names → WeFact codes ────────────────────────────────────
//
// Filters take readable names and translate here; write payloads deliberately
// pass raw WeFact values through, because an agent building a document may need
// an exact code and a lossy translation on writes would be a bug factory.

export const INVOICE_STATUS_FILTER = {
  draft: '0',
  sent: '2',
  partly_paid: '3',
  paid: '4',
  credit: '8',
  expired: '9',
} as const;

export const PRICEQUOTE_STATUS_FILTER = {
  concept: '0',
  sent: '2',
  accepted: '3',
  invoice_created: '4',
  declined: '8',
} as const;

export const CREDITINVOICE_STATUS_FILTER = {
  unpaid: '1',
  partly_paid: '2',
  paid: '3',
  credit: '8',
} as const;

// ── Annotation ──────────────────────────────────────────────────────────────

/**
 * Return a copy of `row` with a human-readable label beside a coded field, e.g.
 * `{ Status: "2" }` → `{ Status: "2", StatusLabel: "sent" }`.
 *
 * Rows without the field, or with a code outside the map, are returned
 * untouched — an unrecognised code is data worth preserving, not an error.
 */
export function annotateOne<T extends Record<string, unknown>>(
  row: T,
  field: string,
  map: Record<string, string>,
  labelField = `${field}Label`,
): T {
  const value = row[field];
  if (value === undefined || value === null) return row;
  const label = map[String(value)];
  if (label === undefined) return row;
  return { ...row, [labelField]: label };
}

/** `annotateOne` across a list of rows. */
export function annotate<T extends Record<string, unknown>>(
  rows: T[],
  field: string,
  map: Record<string, string>,
  labelField?: string,
): T[] {
  return rows.map((row) => annotateOne(row, field, map, labelField));
}

/** Apply several annotations in one pass, for entities with more than one coded field. */
export function annotateAll<T extends Record<string, unknown>>(
  rows: T[],
  specs: Array<{ field: string; map: Record<string, string>; labelField?: string }>,
): T[] {
  return rows.map((row) => specs.reduce((acc, s) => annotateOne(acc, s.field, s.map, s.labelField), row));
}
