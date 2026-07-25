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
import { annotate, annotateOne, PRICEQUOTE_STATUS_FILTER, PRICEQUOTE_STATUS_LABELS } from './enums.js';
import { buildSelector } from './write-helpers.js';

/**
 * Price quotes (offertes) — read side.
 *
 * Endpoints:
 *   list_price_quotes → controller `pricequote`, action `list`
 *   get_price_quote   → controller `pricequote`, action `show`
 */
export function registerPriceQuoteTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'list_price_quotes',
    {
      description:
        'List price quotes (offertes). Rows carry Identifier, PriceQuoteCode, the customer, amounts, Date, ' +
        'Status and Archived, annotated with StatusLabel. ' +
        'Filter by `status`: "concept", "sent", "accepted", "invoice_created" or "declined"; by `archived`; and ' +
        'by date with dateFrom/dateTo (quote date) or expiresFrom/expiresTo (validity). ' +
        'The default search fields are "PriceQuoteCode|CompanyName|SurName". Newest first by default. ' +
        'Auto-paginated. Calls controller `pricequote`, action `list`.',
      inputSchema: {
        status: z
          .enum(['concept', 'sent', 'accepted', 'invoice_created', 'declined'])
          .optional()
          .describe('Filter on quote status.'),
        archived: z.boolean().optional().describe('true for archived quotes only, false to exclude them.'),
        ...listParamsShape,
        ...dateFilterShape,
        expiresFrom: dateFilterShape.dateFrom.describe('Filter on expiry date: start of range (YYYY-MM-DD).'),
        expiresTo: dateFilterShape.dateTo.describe('Filter on expiry date: end of range (YYYY-MM-DD).'),
        administration: administrationArg,
      },
    },
    async ({ status, archived, maxItems, administration, expiresFrom, expiresTo, ...rest }) =>
      guard(async () => {
        const { items, totalResults, truncated } = await client.paginate<Record<string, unknown>>('pricequote', {
          administration,
          itemsKey: 'pricequotes',
          maxItems,
          params: {
            ...buildListParams(rest),
            ...buildDateFilters(rest, 'date'),
            expirationdate: dateRange(expiresFrom, expiresTo),
            status: status ? PRICEQUOTE_STATUS_FILTER[status] : undefined,
            archived: archived === undefined ? undefined : archived ? 1 : 0,
          },
        });
        return ok({
          count: items.length,
          totalResults,
          truncated,
          priceQuotes: annotate(items, 'Status', PRICEQUOTE_STATUS_LABELS),
        });
      }),
  );

  server.registerTool(
    'get_price_quote',
    {
      description:
        'Read one price quote (offerte) in full: the snapshotted customer details, all quote lines, amounts, ' +
        'validity term, status and archive flag, and attachments. ' +
        '`AcceptURL` is the link the customer uses to accept online — it is empty until the quote has been sent. ' +
        'Look up by numeric `identifier` or by `code` (PriceQuoteCode). ' +
        'Calls controller `pricequote`, action `show`.',
      inputSchema: {
        ...identifierShape('PriceQuoteCode', 'price quote', 'OF2024-0001'),
        administration: administrationArg,
      },
    },
    async ({ identifier, code, administration }) =>
      guard(async () => {
        const envelope = await client.request({
          administration,
          ...EP.priceQuoteShow,
          params: buildSelector('PriceQuoteCode', { identifier, code }, 'price quote'),
        });
        const quote = envelope['pricequote'] as Record<string, unknown> | undefined;
        return ok({ priceQuote: quote ? annotateOne(quote, 'Status', PRICEQUOTE_STATUS_LABELS) : null });
      }),
  );
}
