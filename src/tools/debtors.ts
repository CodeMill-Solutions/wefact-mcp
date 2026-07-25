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
import { annotateOne, INVOICE_METHOD_LABELS } from './enums.js';
import { buildSelector } from './write-helpers.js';

/**
 * Debtors (klanten — customers) — read side.
 *
 * Endpoints:
 *   list_debtors → controller `debtor`, action `list`
 *   get_debtor   → controller `debtor`, action `show`
 */
export function registerDebtorTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'list_debtors',
    {
      description:
        'List debtors (klanten — customers). Each row has Identifier, DebtorCode, CompanyName, Sex, Initials, ' +
        'SurName, EmailAddress and Modified; use get_debtor for the full record. ' +
        'Search with `searchfor` plus `searchat` — WeFact only searches "DebtorCode|CompanyName|SurName" unless ' +
        'you name other fields, so to find someone by email you must pass searchat: "EmailAddress". ' +
        'Filter by customer group with `groupId`, and by creation/modification date with the createdFrom/To and ' +
        'modifiedFrom/To arguments. Sorted by DebtorCode ascending by default. Auto-paginated. ' +
        'Calls controller `debtor`, action `list`.',
      inputSchema: {
        ...listParamsShape,
        groupId: z.number().int().positive().optional().describe('Filter on a customer group id. See list_groups.'),
        createdFrom: dateFilterShape.createdFrom,
        createdTo: dateFilterShape.createdTo,
        modifiedFrom: dateFilterShape.modifiedFrom,
        modifiedTo: dateFilterShape.modifiedTo,
        administration: administrationArg,
      },
    },
    async ({ groupId, maxItems, administration, ...rest }) =>
      guard(async () => {
        const { items, totalResults, truncated } = await client.paginate<Record<string, unknown>>('debtor', {
          administration,
          itemsKey: 'debtors',
          maxItems,
          params: {
            ...buildListParams(rest),
            ...buildDateFilters(rest, null),
            group: groupId,
          },
        });
        return ok({ count: items.length, totalResults, truncated, debtors: items });
      }),
  );

  server.registerTool(
    'get_debtor',
    {
      description:
        'Read one debtor (klant — customer) in full: address and separate invoice address, VAT and Chamber of ' +
        'Commerce numbers, payment preferences (InvoiceMethod, InvoiceTerm, DirectDebitApplyTo), mandate and bank ' +
        'details, group memberships and any extra contact persons. ' +
        'Note that InvoiceTerm, PeriodicInvoiceDays and PaymentMail come back as -1 when the customer simply ' +
        'follows the administration default. Look up by numeric `identifier` or by `code` (DebtorCode). ' +
        'Calls controller `debtor`, action `show`.',
      inputSchema: {
        ...identifierShape('DebtorCode', 'debtor', 'DB10000'),
        administration: administrationArg,
      },
    },
    async ({ identifier, code, administration }) =>
      guard(async () => {
        const envelope = await client.request({
          administration,
          ...EP.debtorShow,
          params: buildSelector('DebtorCode', { identifier, code }, 'debtor'),
        });
        const debtor = envelope['debtor'] as Record<string, unknown> | undefined;
        return ok({
          debtor: debtor ? annotateOne(debtor, 'InvoiceMethod', INVOICE_METHOD_LABELS) : null,
        });
      }),
  );
}
