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
import { annotate, annotateOne, PERIODIC_LABELS } from './enums.js';
import { buildSelector } from './write-helpers.js';

/**
 * Products (producten) — read side.
 *
 * Endpoints:
 *   list_products → controller `product`, action `list`
 *   get_product   → controller `product`, action `show`
 */
export function registerProductTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'list_products',
    {
      description:
        'List products. Each row has Identifier, ProductCode, ProductName, ProductKeyPhrase, PriceExcl, TaxCode, ' +
        'TaxPercentage and PricePeriod, annotated with PricePeriodLabel (month, quarter, year, …) so recurring ' +
        'products are recognisable at a glance. ' +
        'The default search fields are "ProductCode|ProductName|ProductKeyPhrase"; name others via `searchat`. ' +
        'Filter by product group with `groupId`. Sorted by ProductCode ascending by default. Auto-paginated. ' +
        'Calls controller `product`, action `list`.',
      inputSchema: {
        ...listParamsShape,
        groupId: z.number().int().positive().optional().describe('Filter on a product group id. See list_groups.'),
        createdFrom: dateFilterShape.createdFrom,
        createdTo: dateFilterShape.createdTo,
        modifiedFrom: dateFilterShape.modifiedFrom,
        modifiedTo: dateFilterShape.modifiedTo,
        administration: administrationArg,
      },
    },
    async ({ groupId, maxItems, administration, ...rest }) =>
      guard(async () => {
        const { items, totalResults, truncated } = await client.paginate<Record<string, unknown>>('product', {
          administration,
          itemsKey: 'products',
          maxItems,
          params: { ...buildListParams(rest), ...buildDateFilters(rest, null), group: groupId },
        });
        return ok({
          count: items.length,
          totalResults,
          truncated,
          products: annotate(items, 'PricePeriod', PERIODIC_LABELS),
        });
      }),
  );

  server.registerTool(
    'get_product',
    {
      description:
        'Read one product in full: pricing, VAT code, unit suffix, barcode, the subscription period if it is a ' +
        'recurring product, and its group memberships. ' +
        'Remember that putting a ProductCode on an invoice or quote line makes WeFact auto-fill the description, ' +
        'price, VAT code and recurrence from this record. ' +
        'Look up by numeric `identifier` or by `code` (ProductCode). Calls controller `product`, action `show`.',
      inputSchema: {
        ...identifierShape('ProductCode', 'product', 'P0001'),
        administration: administrationArg,
      },
    },
    async ({ identifier, code, administration }) =>
      guard(async () => {
        const envelope = await client.request({
          administration,
          ...EP.productShow,
          params: buildSelector('ProductCode', { identifier, code }, 'product'),
        });
        const product = envelope['product'] as Record<string, unknown> | undefined;
        return ok({ product: product ? annotateOne(product, 'PricePeriod', PERIODIC_LABELS) : null });
      }),
  );
}
