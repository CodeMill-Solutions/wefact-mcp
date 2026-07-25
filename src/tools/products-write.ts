import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { guard } from './result.js';
import { administrationArg, confirmArg } from './schemas.js';
import { PERIODIC_VALUES } from './enums.js';
import { buildSelector, compact, gatedWrite } from './write-helpers.js';

/**
 * Products (producten) — write side.
 *
 * Deleting a product lives in `delete_record` with the other destructive
 * operations.
 *
 * Endpoints:
 *   save_product → controller `product`, actions `add` / `edit`
 */
export function registerProductWriteTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'save_product',
    {
      description:
        'Create or update a product. ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default: it only writes ' +
        'when `confirm: true` is passed; otherwise it returns the exact body it would send. ' +
        '`action: "add"` requires `ProductName`, `ProductKeyPhrase` (the text that appears on the invoice) and ' +
        '`PriceExcl`. `action: "edit"` requires `identifier` or `code`. Omit `ProductCode` on add to let WeFact ' +
        'assign the next product number. ' +
        'Set `PricePeriod` to make this a subscription product — invoice and quote lines that reference it then ' +
        'inherit the recurrence automatically. To remove a product use delete_record with type "product". ' +
        'Calls controller `product`, actions `add` / `edit`.',
      inputSchema: {
        action: z.enum(['add', 'edit']).describe('"add" to create a new product, "edit" to update an existing one.'),
        identifier: z.number().int().positive().optional().describe('Product Identifier. Required for "edit".'),
        code: z.string().optional().describe('ProductCode, e.g. "P0001". Alternative lookup key for "edit".'),

        ProductName: z.string().optional().describe('Product name (internal). Required for "add".'),
        ProductKeyPhrase: z.string().optional().describe('Description shown on the invoice. Required for "add".'),
        ProductDescription: z.string().optional().describe('Longer internal description.'),
        PriceExcl: z.number().optional().describe('Unit price excluding VAT. Required for "add".'),
        TaxCode: z.string().optional().describe('VAT code, e.g. "V21". See get_settings for the available codes.'),
        NumberSuffix: z.string().optional().describe('Unit shown after the quantity, e.g. "Kg." or "uur".'),
        Barcode: z.string().optional().describe('Barcode.'),
        PricePeriod: z
          .enum(PERIODIC_VALUES)
          .optional()
          .describe(
            'Subscription period: d day, w week, m month, k quarter, h half year, j year, t two years. ' +
              'Leave unset for a one-off product.',
          ),

        AccountingCostCentre: z
          .string()
          .optional()
          .describe('Cost centre code — only if accounting integration is on.'),
        AccountingProject: z.string().optional().describe('Project code — only if accounting integration is on.'),
        ProductCode: z
          .string()
          .optional()
          .describe('Set an explicit product number on "add". Omit to let WeFact assign the next one.'),
        Groups: z.array(z.number().int()).optional().describe('Product group ids this product belongs to.'),
        ProductInventory: z
          .record(z.unknown())
          .optional()
          .describe(
            'Inventory module container, e.g. { "IsProductInventoryEnabled": "yes", "TotalStock": 10, ' +
              '"StockWarningThreshold": "2", "SupplierIds": [1], "WarehouseID": 1 }.',
          ),

        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ action, identifier, code, confirm, administration, ...fields }) =>
      guard(async () => {
        if (action === 'add') {
          const missing = (['ProductName', 'ProductKeyPhrase', 'PriceExcl'] as const).filter(
            (f) => fields[f] === undefined,
          );
          if (missing.length > 0) {
            throw new Error(`Creating a product requires ${missing.join(', ')}.`);
          }
        }

        const selector = action === 'edit' ? buildSelector('ProductCode', { identifier, code }, 'product') : {};
        const body = { ...selector, ...compact(fields) } as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: action === 'add' ? 'created' : 'updated',
          plannedKey: 'plannedProduct',
          resultKey: 'product',
          body,
          extra: { action },
          execute: async () => {
            const envelope = await client.request({
              administration,
              ...(action === 'add' ? EP.productAdd : EP.productEdit),
              params: body,
            });
            return envelope['product'] ?? null;
          },
        });
      }),
  );
}
