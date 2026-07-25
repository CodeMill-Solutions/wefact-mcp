import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { ok, guard } from './result.js';
import {
  administrationArg,
  buildDateFilters,
  buildListParams,
  dateFilterShape,
  dateRange,
  identifierShape,
  listParamsShape,
} from './schemas.js';
import {
  annotateAll,
  annotateOne,
  INVOICE_METHOD_LABELS,
  INVOICE_STATUS_FILTER,
  INVOICE_STATUS_LABELS,
  INVOICE_SUBSTATUS_LABELS,
  PAYMENT_METHOD_LABELS,
} from './enums.js';
import { buildSelector } from './write-helpers.js';

/**
 * Sales invoices (facturen) — read side.
 *
 * Endpoints:
 *   list_invoices → controller `invoice`, action `list`
 *   get_invoice   → controller `invoice`, action `show`
 */
export function registerInvoiceTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'list_invoices',
    {
      description:
        'List sales invoices (facturen). Rows carry Identifier, InvoiceCode, DebtorCode, the amounts ' +
        '(AmountExcl/Incl/Paid/Outstanding), Date, PayBefore, Status and reminder counters, annotated with ' +
        'StatusLabel and SubStatusLabel. Use get_invoice for the lines. ' +
        'Filter by `status` ("draft", "sent", "partly_paid", "paid", "credit", "expired"), by customer with ' +
        '`debtorCode`, and by date with dateFrom/dateTo (invoice date), payBeforeFrom/To (due date) or ' +
        'payDateFrom/To (payment date) — so overdue invoices are `status: "sent"` plus a payBeforeTo of today. ' +
        'NOTE: WeFact has no debtor filter of its own; `debtorCode` works by rewriting the search, so it cannot ' +
        'be combined with a custom `searchat`/`searchfor`. Newest first by default. Auto-paginated. ' +
        'Calls controller `invoice`, action `list`.',
      inputSchema: {
        status: z
          .enum(['draft', 'sent', 'partly_paid', 'paid', 'credit', 'expired'])
          .optional()
          .describe('Filter on invoice status. Only one status at a time.'),
        debtorCode: z
          .string()
          .optional()
          .describe(
            'Only invoices for this customer, e.g. "DB10000". Implemented as searchat=DebtorCode, so do not ' +
              'combine it with your own searchat/searchfor.',
          ),
        ...listParamsShape,
        ...dateFilterShape,
        payBeforeFrom: dateFilterShape.dateFrom.describe('Filter on due date: start of range (YYYY-MM-DD).'),
        payBeforeTo: dateFilterShape.dateTo.describe('Filter on due date: end of range (YYYY-MM-DD).'),
        payDateFrom: dateFilterShape.dateFrom.describe('Filter on payment date: start of range (YYYY-MM-DD).'),
        payDateTo: dateFilterShape.dateTo.describe('Filter on payment date: end of range (YYYY-MM-DD).'),
        administration: administrationArg,
      },
    },
    async ({
      status,
      debtorCode,
      maxItems,
      administration,
      payBeforeFrom,
      payBeforeTo,
      payDateFrom,
      payDateTo,
      ...rest
    }) =>
      guard(async () => {
        if (debtorCode && (rest.searchat || rest.searchfor)) {
          throw new Error(
            '`debtorCode` and `searchat`/`searchfor` cannot be combined — WeFact has only one search slot. ' +
              'Use searchat: "DebtorCode", searchfor: "<code>" if you need to control the search yourself.',
          );
        }

        const search = debtorCode ? { searchat: 'DebtorCode', searchfor: debtorCode } : buildListParams(rest);

        const { items, totalResults, truncated } = await client.paginate<Record<string, unknown>>('invoice', {
          administration,
          itemsKey: 'invoices',
          maxItems,
          params: {
            ...buildListParams(rest),
            ...search,
            ...buildDateFilters(rest, 'date'),
            paybefore: dateRange(payBeforeFrom, payBeforeTo),
            paydate: dateRange(payDateFrom, payDateTo),
            status: status ? INVOICE_STATUS_FILTER[status] : undefined,
          },
        });

        return ok({
          count: items.length,
          totalResults,
          truncated,
          invoices: annotateAll(items, [
            { field: 'Status', map: INVOICE_STATUS_LABELS },
            { field: 'SubStatus', map: INVOICE_SUBSTATUS_LABELS },
          ]),
        });
      }),
  );

  server.registerTool(
    'get_invoice',
    {
      description:
        'Read one sales invoice in full: the snapshotted customer details, all invoice lines with their VAT codes ' +
        'and periods, amounts and outstanding balance, payment status and PaymentURL, reminder and summation ' +
        'counters, scheduling, and attachments. Status and PaymentMethod are annotated with readable labels. ' +
        'Draft invoices have a placeholder InvoiceCode of the form "[concept]0001" — the real number is only ' +
        'assigned when the invoice is sent. Look up by numeric `identifier` or by `code` (InvoiceCode). ' +
        'Calls controller `invoice`, action `show`.',
      inputSchema: {
        ...identifierShape('InvoiceCode', 'invoice', 'F2024-0001'),
        administration: administrationArg,
      },
    },
    async ({ identifier, code, administration }) =>
      guard(async () => {
        const envelope = await client.request({
          administration,
          ...EP.invoiceShow,
          params: buildSelector('InvoiceCode', { identifier, code }, 'invoice'),
        });
        const invoice = envelope['invoice'] as Record<string, unknown> | undefined;
        if (!invoice) return ok({ invoice: null });

        let annotated = annotateOne(invoice, 'Status', INVOICE_STATUS_LABELS);
        annotated = annotateOne(annotated, 'SubStatus', INVOICE_SUBSTATUS_LABELS);
        annotated = annotateOne(annotated, 'PaymentMethod', PAYMENT_METHOD_LABELS);
        annotated = annotateOne(annotated, 'InvoiceMethod', INVOICE_METHOD_LABELS);

        return ok({ invoice: annotated });
      }),
  );
}
