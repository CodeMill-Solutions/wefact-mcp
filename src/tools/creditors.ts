import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
import { buildSelector } from './write-helpers.js';

/**
 * Creditors (leveranciers — suppliers) — read side.
 *
 * Endpoints:
 *   list_creditors → controller `creditor`, action `list`
 *   get_creditor   → controller `creditor`, action `show`
 */
export function registerCreditorTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'list_creditors',
    {
      description:
        'List creditors (leveranciers — suppliers). Each row has Identifier, CreditorCode, CompanyName, Sex, ' +
        'Initials, SurName, EmailAddress and Modified; use get_creditor for the full record. ' +
        'Search with `searchfor` plus `searchat` — the default search fields are ' +
        '"CreditorCode|CompanyName|SurName", so searching any other field means naming it explicitly. ' +
        'Unlike customers there is no group filter. Sorted by CreditorCode ascending by default. Auto-paginated. ' +
        'Calls controller `creditor`, action `list`.',
      inputSchema: {
        ...listParamsShape,
        createdFrom: dateFilterShape.createdFrom,
        createdTo: dateFilterShape.createdTo,
        modifiedFrom: dateFilterShape.modifiedFrom,
        modifiedTo: dateFilterShape.modifiedTo,
        administration: administrationArg,
      },
    },
    async ({ maxItems, administration, ...rest }) =>
      guard(async () => {
        const { items, totalResults, truncated } = await client.paginate<Record<string, unknown>>('creditor', {
          administration,
          itemsKey: 'creditors',
          maxItems,
          params: { ...buildListParams(rest), ...buildDateFilters(rest, null) },
        });
        return ok({ count: items.length, totalResults, truncated, creditors: items });
      }),
  );

  server.registerTool(
    'get_creditor',
    {
      description:
        'Read one creditor (leverancier — supplier) in full: address, VAT and Chamber of Commerce numbers, bank ' +
        'details, payment term, direct-debit setting and the booking rules that pre-fill purchase invoices. ' +
        '`MyCustomerCode` is your own account number at that supplier. ' +
        'Look up by numeric `identifier` or by `code` (CreditorCode). Calls controller `creditor`, action `show`.',
      inputSchema: {
        ...identifierShape('CreditorCode', 'creditor', 'CR10000'),
        administration: administrationArg,
      },
    },
    async ({ identifier, code, administration }) =>
      guard(async () => {
        const envelope = await client.request({
          administration,
          ...EP.creditorShow,
          params: buildSelector('CreditorCode', { identifier, code }, 'creditor'),
        });
        return ok({ creditor: envelope['creditor'] ?? null });
      }),
  );
}
