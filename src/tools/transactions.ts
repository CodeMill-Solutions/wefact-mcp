import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { ok, guard } from './result.js';
import { administrationArg } from './schemas.js';
import { annotate, annotateOne, BANK_TRANSACTION_STATUS_LABELS, BANK_TRANSACTION_STATUSES } from './enums.js';

/**
 * Bank transactions (banktransacties) — read side.
 *
 * Addressed by `Identifier` only; there is no human-readable code. This
 * controller also breaks the usual list conventions: it has `searchfor` but no
 * `searchat`, and its default sort field is the lowercase `date`.
 *
 * Endpoints:
 *   list_transactions → controller `transaction`, action `list`
 *   get_transaction   → controller `transaction`, action `show`
 */
export function registerTransactionTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'list_transactions',
    {
      description:
        'List bank transactions. Rows carry Identifier, Date, Type, Amount, Currency, the counterparty details, ' +
        'the descriptions and Status, annotated with StatusLabel. ' +
        'Filter by `direction` ("incoming" / "outgoing") and by `status` — "unmatched" is the useful one for ' +
        'finding money that still needs reconciling against invoices. ' +
        'This controller has a plain `searchfor` with no `searchat`, and sorts by date descending by default. ' +
        'Auto-paginated. Calls controller `transaction`, action `list`.',
      inputSchema: {
        direction: z.enum(['incoming', 'outgoing']).optional().describe('Money in or money out.'),
        status: z
          .enum(BANK_TRANSACTION_STATUSES)
          .optional()
          .describe('Reconciliation status. "unmatched" finds transactions still to be matched to a document.'),
        searchfor: z.string().optional().describe('Free-text search across the transaction fields.'),
        sort: z.string().optional().describe('Field to sort on. WeFact defaults to "date".'),
        order: z.enum(['ASC', 'DESC']).optional().describe('Sort direction. Defaults to DESC.'),
        maxItems: z.number().int().positive().optional().describe('Cap on total rows returned (default 1000).'),
        administration: administrationArg,
      },
    },
    async ({ direction, status, searchfor, sort, order, maxItems, administration }) =>
      guard(async () => {
        const { items, totalResults, truncated } = await client.paginate<Record<string, unknown>>('transaction', {
          administration,
          itemsKey: 'transactions',
          maxItems,
          params: { transactionDirection: direction, status, searchfor, sort, order },
        });
        return ok({
          count: items.length,
          totalResults,
          truncated,
          transactions: annotate(items, 'Status', BANK_TRANSACTION_STATUS_LABELS),
        });
      }),
  );

  server.registerTool(
    'get_transaction',
    {
      description:
        'Read one bank transaction in full, including its `Matches` — the invoices or purchase invoices it has ' +
        'already been reconciled against, with the amount attributed to each. `Origin` shows where it came from ' +
        '("api" for transactions this server created). ' +
        'REQUIRES the numeric `identifier` — bank transactions have no code. ' +
        'Calls controller `transaction`, action `show`.',
      inputSchema: {
        identifier: z.number().int().positive().describe('Transaction Identifier.'),
        administration: administrationArg,
      },
    },
    async ({ identifier, administration }) =>
      guard(async () => {
        const envelope = await client.request({
          administration,
          ...EP.transactionShow,
          params: { Identifier: identifier },
        });
        const tx = envelope['transaction'] as Record<string, unknown> | undefined;
        return ok({ transaction: tx ? annotateOne(tx, 'Status', BANK_TRANSACTION_STATUS_LABELS) : null });
      }),
  );
}
