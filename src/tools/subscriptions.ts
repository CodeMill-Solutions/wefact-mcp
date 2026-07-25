import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { ok, guard } from './result.js';
import { administrationArg, buildDateFilters, buildListParams, dateFilterShape, listParamsShape } from './schemas.js';
import { annotate, annotateOne, PERIODIC_LABELS } from './enums.js';

/**
 * Subscriptions (abonnementen / "overige diensten") — read side.
 *
 * Subscriptions are addressed by `Identifier` only: unlike every other document
 * type there is no code-based lookup.
 *
 * Endpoints:
 *   list_subscriptions → controller `subscription`, action `list`
 *   get_subscription   → controller `subscription`, action `show`
 */
export function registerSubscriptionTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'list_subscriptions',
    {
      description:
        'List subscriptions (abonnementen — recurring services billed automatically). ' +
        'Filter by `status`: "active" (the default in WeFact, and includes subscriptions already cancelled with a ' +
        'future end date) or "terminated". ' +
        'The default search fields are "DebtorCode|ProductCode|Description", so `searchfor` with a customer number ' +
        'works out of the box here — unlike on invoices. Sorted by NextDate ascending by default, which makes ' +
        '"what is billed next" the natural first page. ' +
        'There is no filter on NextDate, StartDate or TerminationDate — only created/modified. Auto-paginated. ' +
        'Calls controller `subscription`, action `list`.',
      inputSchema: {
        status: z
          .enum(['active', 'terminated'])
          .optional()
          .describe('Filter on subscription status. Default "active".'),
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
        const { items, totalResults, truncated } = await client.paginate<Record<string, unknown>>('subscription', {
          administration,
          itemsKey: 'subscriptions',
          maxItems,
          params: { ...buildListParams(rest), ...buildDateFilters(rest, null), status },
        });
        return ok({
          count: items.length,
          totalResults,
          truncated,
          subscriptions: annotate(items, 'Periodic', PERIODIC_LABELS),
        });
      }),
  );

  server.registerTool(
    'get_subscription',
    {
      description:
        'Read one subscription in full: the customer, the product and description, quantity and price, the ' +
        'recurrence (Periods × Periodic — e.g. 3 × "m" is every three months), StartDate, NextDate (when it is ' +
        'billed next), any TerminationDate or TerminateAfter count, and the direct-debit setting. ' +
        'Periodic is annotated with a readable label. ' +
        'REQUIRES the numeric `identifier` — WeFact has no code-based lookup for subscriptions. ' +
        'Calls controller `subscription`, action `show`.',
      inputSchema: {
        identifier: z.number().int().positive().describe('Subscription Identifier. The only accepted lookup key.'),
        administration: administrationArg,
      },
    },
    async ({ identifier, administration }) =>
      guard(async () => {
        const envelope = await client.request({
          administration,
          ...EP.subscriptionShow,
          params: { Identifier: identifier },
        });
        const sub = envelope['subscription'] as Record<string, unknown> | undefined;
        return ok({ subscription: sub ? annotateOne(sub, 'Periodic', PERIODIC_LABELS) : null });
      }),
  );
}
