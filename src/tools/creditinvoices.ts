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
  identifierShape,
  listParamsShape,
} from './schemas.js';
import {
  annotate,
  annotateOne,
  CREDITINVOICE_STATUS_FILTER,
  CREDITINVOICE_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
} from './enums.js';
import { buildSelector } from './write-helpers.js';

/**
 * Purchase invoices (inkoopfacturen) — read side.
 *
 * WeFact calls these "credit invoices", which is confusing: they are invoices
 * you RECEIVE from a supplier, not credit notes. Two numbers coexist —
 * `CreditInvoiceCode` is your own internal number and the only lookup key,
 * while `InvoiceCode` is the supplier's number and is searchable but not a
 * selector.
 *
 * Note the status scale differs from sales invoices: here 1 is unpaid and there
 * is no 0/draft.
 *
 * Endpoints:
 *   list_credit_invoices → controller `creditinvoice`, action `list`
 *   get_credit_invoice   → controller `creditinvoice`, action `show`
 */
export function registerCreditInvoiceTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'list_credit_invoices',
    {
      description:
        'List purchase invoices (inkoopfacturen — bills received FROM suppliers, not credit notes). Rows carry ' +
        "Identifier, CreditInvoiceCode (your internal number), InvoiceCode (the supplier's number), the supplier, " +
        'amounts, Term, PayBefore and Status, annotated with StatusLabel. ' +
        'Filter by `status`: "unpaid", "partly_paid", "paid" or "credit" — note this scale is DIFFERENT from sales ' +
        'invoices, where 0 means draft. The default search fields are ' +
        '"CreditInvoiceCode|InvoiceCode|CompanyName|SurName|Description". Newest first by default. Auto-paginated. ' +
        'Calls controller `creditinvoice`, action `list`.',
      inputSchema: {
        status: z
          .enum(['unpaid', 'partly_paid', 'paid', 'credit'])
          .optional()
          .describe('Filter on purchase invoice status.'),
        ...listParamsShape,
        createdFrom: dateFilterShape.createdFrom,
        createdTo: dateFilterShape.createdTo,
        modifiedFrom: dateFilterShape.modifiedFrom,
        modifiedTo: dateFilterShape.modifiedTo,
        administration: administrationArg,
      },
    },
    async ({ status, maxItems, administration, ...rest }) =>
      guard(async () => {
        const { items, totalResults, truncated } = await client.paginate<Record<string, unknown>>('creditinvoice', {
          administration,
          itemsKey: 'creditinvoices',
          maxItems,
          params: {
            ...buildListParams(rest),
            ...buildDateFilters(rest, null),
            status: status ? CREDITINVOICE_STATUS_FILTER[status] : undefined,
          },
        });
        return ok({
          count: items.length,
          totalResults,
          truncated,
          creditInvoices: annotate(items, 'Status', CREDITINVOICE_STATUS_LABELS),
        });
      }),
  );

  server.registerTool(
    'get_credit_invoice',
    {
      description:
        'Read one purchase invoice (inkoopfactuur) in full: the supplier, both invoice numbers, amounts and ' +
        'outstanding balance, payment status and method, the authorisation state, all lines with their VAT codes ' +
        'and cost categories, and attachments. ' +
        'Look up by numeric `identifier` or by `code` — and note that `code` means your own CreditInvoiceCode, ' +
        "not the supplier's InvoiceCode, which is not a valid lookup key. " +
        'Calls controller `creditinvoice`, action `show`.',
      inputSchema: {
        ...identifierShape('CreditInvoiceCode', 'purchase invoice', 'CF0002'),
        administration: administrationArg,
      },
    },
    async ({ identifier, code, administration }) =>
      guard(async () => {
        const envelope = await client.request({
          administration,
          ...EP.creditInvoiceShow,
          params: buildSelector('CreditInvoiceCode', { identifier, code }, 'purchase invoice'),
        });
        const ci = envelope['creditinvoice'] as Record<string, unknown> | undefined;
        if (!ci) return ok({ creditInvoice: null });

        let annotated = annotateOne(ci, 'Status', CREDITINVOICE_STATUS_LABELS);
        annotated = annotateOne(annotated, 'PaymentMethod', PAYMENT_METHOD_LABELS);
        return ok({ creditInvoice: annotated });
      }),
  );
}
