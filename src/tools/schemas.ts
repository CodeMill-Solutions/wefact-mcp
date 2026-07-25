import { z } from 'zod';

/**
 * Zod shapes and parameter builders shared across the tool modules.
 *
 * Two of these earn their keep by hiding a WeFact quirk that agents otherwise
 * get wrong every time:
 *
 *   - Date filters are nested objects (`{ date: { from, to } }`), not strings.
 *     Tools expose flat `dateFrom` / `dateTo` arguments and `buildDateFilters()`
 *     assembles the nested shape.
 *   - `searchat` is a pipe-separated field list whose default differs per
 *     controller, so searching a field outside that default silently returns
 *     nothing. Every list tool documents its own default.
 */

// ── Universal arguments ─────────────────────────────────────────────────────

export const administrationArg = z
  .string()
  .optional()
  .describe('Credentials label selecting which API key to use. Defaults to WEFACT_ADMINISTRATION.');

export const confirmArg = z
  .boolean()
  .optional()
  .describe('Set true to actually perform the write. When false/omitted, returns a dry-run preview only.');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export const dateArg = z.string().regex(DATE_RE, 'Date must be formatted YYYY-MM-DD.');
export const dateTimeArg = z.string().regex(DATETIME_RE, 'Timestamp must be formatted "YYYY-MM-DD HH:MM:SS".');

// ── Identifier / code selector ──────────────────────────────────────────────

/**
 * Most WeFact actions accept either the numeric `Identifier` or the entity's
 * human-readable code. Build the pair of arguments for one entity.
 */
export function identifierShape(codeField: string, entity: string, example: string) {
  return {
    identifier: z.number().int().positive().optional().describe(`Numeric ${entity} Identifier.`),
    code: z.string().optional().describe(`${codeField}, e.g. "${example}". Use this or \`identifier\`.`),
  };
}

// ── List parameters ─────────────────────────────────────────────────────────

/**
 * The pagination/search block every WeFact `list` action shares. Per-controller
 * defaults for `sort`, `order` and `searchat` differ, so each tool restates its
 * own in the tool description rather than here.
 */
export const listParamsShape = {
  offset: z.number().int().min(0).optional().describe('Row offset for manual paging (default 0).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('Rows per page (WeFact max 1000). Leave unset — this server pages automatically.'),
  sort: z.string().optional().describe('Field to sort on, e.g. "Date" or "DebtorCode".'),
  order: z.enum(['ASC', 'DESC']).optional().describe('Sort direction.'),
  searchat: z
    .string()
    .optional()
    .describe(
      'Pipe-separated list of fields to search in, e.g. "DebtorCode|CompanyName". Each controller has its own ' +
        'default set; a field outside that set must be named here explicitly or the search silently misses it.',
    ),
  searchfor: z.string().optional().describe('Value to search for in the `searchat` fields.'),
  maxItems: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Cap on total rows returned across all pages (default 1000).'),
};

export interface ListParamsInput {
  offset?: number;
  limit?: number;
  sort?: string;
  order?: 'ASC' | 'DESC';
  searchat?: string;
  searchfor?: string;
}

/** Map the shared list arguments onto WeFact's own parameter names. */
export function buildListParams(input: ListParamsInput): Record<string, unknown> {
  return {
    offset: input.offset,
    limit: input.limit,
    sort: input.sort,
    order: input.order,
    searchat: input.searchat,
    searchfor: input.searchfor,
  };
}

// ── Date filters ────────────────────────────────────────────────────────────

/**
 * Flat date-range arguments. WeFact wants `{ from, to }` objects under a
 * per-controller key (`date`, `modified`, `created`, `paybefore`, …); exposing
 * that nesting to an agent invites malformed filters, so tools take these flat
 * fields and `buildDateFilters()` reassembles them.
 */
export const dateFilterShape = {
  dateFrom: dateArg.optional().describe('Filter on document date: start of range (YYYY-MM-DD).'),
  dateTo: dateArg.optional().describe('Filter on document date: end of range (YYYY-MM-DD).'),
  modifiedFrom: dateTimeArg.optional().describe('Filter on last-modified: start ("YYYY-MM-DD HH:MM:SS").'),
  modifiedTo: dateTimeArg.optional().describe('Filter on last-modified: end ("YYYY-MM-DD HH:MM:SS").'),
  createdFrom: dateTimeArg.optional().describe('Filter on creation date: start ("YYYY-MM-DD HH:MM:SS").'),
  createdTo: dateTimeArg.optional().describe('Filter on creation date: end ("YYYY-MM-DD HH:MM:SS").'),
};

export interface DateFilterInput {
  dateFrom?: string;
  dateTo?: string;
  modifiedFrom?: string;
  modifiedTo?: string;
  createdFrom?: string;
  createdTo?: string;
}

/** Build one `{ from, to }` object, or undefined when neither bound was given. */
export function dateRange(from?: string, to?: string): { from?: string; to?: string } | undefined {
  if (from === undefined && to === undefined) return undefined;
  const range: { from?: string; to?: string } = {};
  if (from !== undefined) range.from = from;
  if (to !== undefined) range.to = to;
  return range;
}

/**
 * Assemble WeFact's nested date filters from the flat arguments. `dateKey`
 * varies per controller — invoices use `date`, quotes also accept
 * `expirationdate`, and some controllers have no document-date filter at all.
 */
export function buildDateFilters(input: DateFilterInput, dateKey: string | null = 'date'): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (dateKey) {
    const range = dateRange(input.dateFrom, input.dateTo);
    if (range) out[dateKey] = range;
  }
  const modified = dateRange(input.modifiedFrom, input.modifiedTo);
  if (modified) out['modified'] = modified;
  const created = dateRange(input.createdFrom, input.createdTo);
  if (created) out['created'] = created;
  return out;
}

// ── Attachments ─────────────────────────────────────────────────────────────

/**
 * Parent entity types for the shared `attachment` controller. Note the `crm_`
 * prefix on the two CRM types — `task` and `interaction` are rejected.
 */
export const ATTACHMENT_TYPES = [
  'debtor',
  'creditor',
  'invoice',
  'pricequote',
  'creditinvoice',
  'crm_task',
  'crm_interaction',
] as const;

export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

export const attachmentTypeArg = z
  .enum(ATTACHMENT_TYPES)
  .describe(
    'Type of the parent record the attachment belongs to. NOTE the crm_ prefix on crm_task and crm_interaction.',
  );

/**
 * The human-code field each attachment parent accepts alongside
 * `ReferenceIdentifier`. CRM records have no code, so they are id-only.
 */
export const ATTACHMENT_PARENT_CODE_FIELD: Record<AttachmentType, string | null> = {
  debtor: 'DebtorCode',
  creditor: 'CreditorCode',
  invoice: 'InvoiceCode',
  pricequote: 'PriceQuoteCode',
  creditinvoice: 'CreditInvoiceCode',
  crm_task: null,
  crm_interaction: null,
};

// ── Document lines ──────────────────────────────────────────────────────────

/**
 * One line on an invoice or price quote. Supplying `ProductCode` makes WeFact
 * auto-fill Description, PriceExcl, TaxCode, PeriodicType, Periods, Periodic and
 * StartDate from the product, so a line can legitimately be just a code and a
 * quantity.
 */
export const documentLineSchema = z
  .object({
    Identifier: z.number().int().positive().optional().describe('Existing line id — only when editing a line.'),
    Date: dateArg.optional().describe('Line date (default: today).'),
    Number: z.number().optional().describe('Quantity (default 1).'),
    NumberSuffix: z.string().optional().describe('Unit shown after the quantity, e.g. "Kg." or "uur".'),
    ProductCode: z.string().optional().describe('Product number. Auto-fills the remaining line fields.'),
    Description: z.string().optional().describe('Line description.'),
    PriceExcl: z.number().optional().describe('Unit price excluding VAT.'),
    DiscountPercentage: z.number().min(0).max(100).optional().describe('Line discount percentage (0–100).'),
    DiscountPercentageType: z
      .enum(['line', 'subscription'])
      .optional()
      .describe('Whether the discount applies to this line only, or also to the subscription it creates.'),
    TaxCode: z.string().optional().describe('VAT code from the administration, e.g. "V21". See get_settings.'),
    StartDate: dateArg.optional().describe('Start of the billed period.'),
    EndDate: dateArg.optional().describe('End of the billed period. Only allowed when PeriodicType is "once".'),
    PeriodicType: z
      .enum(['once', 'period'])
      .optional()
      .describe('"once" (default) for a one-off line, "period" to create a recurring subscription line.'),
    Periods: z.number().int().positive().optional().describe('Bill every N periods (default 1).'),
    Periodic: z
      .enum(['d', 'w', 'm', 'k', 'h', 'j', 't'])
      .optional()
      .describe('Period unit: d day, w week, m month, k quarter, h half year, j year, t two years.'),
    AccountingCostCentre: z.string().optional().describe('Cost centre code — only if accounting integration is on.'),
    AccountingProject: z.string().optional().describe('Project code — only if accounting integration is on.'),
  })
  .passthrough();

/**
 * One line on a purchase invoice. Deliberately different from
 * `documentLineSchema`: WeFact has no quantity on purchase lines (put the total
 * in `PriceExcl`) and adds a cost-category link.
 */
export const creditInvoiceLineSchema = z
  .object({
    Identifier: z.number().int().positive().optional().describe('Existing line id — only when editing a line.'),
    Description: z.string().optional().describe('Line description.'),
    PriceExcl: z
      .number()
      .optional()
      .describe('Line total excluding VAT. There is no quantity field on purchase lines.'),
    TaxCode: z.string().optional().describe('Purchase VAT code, e.g. "I21". See get_settings.'),
    // WeFact documents this as an int but REJECTS a JSON number with
    // "Invalid type for 'InvoiceLines[0].CostCategory'" — it must be a string.
    // Verified against the live API; accept either and coerce.
    CostCategory: z
      .union([z.number().int(), z.string()])
      .transform((v) => String(v))
      .optional()
      .describe('Cost-category id from get_settings(section: "cost_categories"). "0" for none.'),
    StartDate: dateArg.optional().describe('Start of the billed period.'),
    EndDate: dateArg.optional().describe('End of the billed period.'),
    AccountingCostCentre: z.string().optional().describe('Cost centre code — only if accounting integration is on.'),
    AccountingProject: z.string().optional().describe('Project code — only if accounting integration is on.'),
  })
  .passthrough();

/** A line reference used by the delete/sort line operations. */
export const lineReferenceSchema = z.object({
  Identifier: z.number().int().positive().describe('Line Identifier, from the parent document via its `get_*` tool.'),
});

// ── Shared response post-processing ─────────────────────────────────────────

/**
 * Pull the non-envelope payload out of a WeFact response, dropping the routing
 * and pagination fields that are noise once a tool has read them.
 */
export function stripEnvelope(envelope: Record<string, unknown>): Record<string, unknown> {
  const { controller, action, status, date, totalresults, currentresults, offset, filters, ...rest } = envelope;
  void controller;
  void action;
  void status;
  void date;
  void totalresults;
  void currentresults;
  void offset;
  void filters;
  return rest;
}
