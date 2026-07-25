import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { ok, guard } from './result.js';
import { administrationArg } from './schemas.js';

/**
 * Administration settings (instellingen) — read side.
 *
 * WeFact exposes settings through the `settings` controller (plural, even though
 * the documentation URL is /setting/…), and its sub-resources are underscore-
 * joined actions rather than a nested controller.
 *
 * Endpoints:
 *   get_settings → controller `settings`, actions `list` / `costcategory_list` / `costcategory_show`
 */
export function registerSettingsTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'get_settings',
    {
      description:
        'Read the administration configuration. `section: "general"` (the default) takes no other parameters and ' +
        'returns the corporate identities — their LanguageCode is what invoices and quotes use to pick a template — ' +
        'plus the VAT code tables (sale codes like V21, purchase codes like I21) and the VAT rules. ' +
        '`section: "cost_categories"` lists cost categories with the numeric ids that purchase-invoice lines ' +
        'require; pass `costCategoryId` to read a single one. ' +
        'Look here first whenever a write tool needs a TaxCode, LanguageCode or CostCategory. ' +
        'Calls controller `settings`, actions `list` / `costcategory_list` / `costcategory_show`.',
      inputSchema: {
        section: z
          .enum(['general', 'cost_categories'])
          .optional()
          .describe('Which settings to read. Default "general".'),
        costCategoryId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Read one cost category by id. Only meaningful with section "cost_categories".'),
        status: z
          .string()
          .optional()
          .describe(
            'Cost-category status filter, default "active". Pipe-separated for several, e.g. "active|removed".',
          ),
        administration: administrationArg,
      },
    },
    async ({ section, costCategoryId, status, administration }) =>
      guard(async () => {
        if (section === 'cost_categories') {
          if (costCategoryId !== undefined) {
            const envelope = await client.request({
              administration,
              ...EP.costCategoryShow,
              params: { Identifier: costCategoryId },
            });
            const payload = (envelope['settings'] ?? {}) as Record<string, unknown>;
            return ok({ costCategory: payload['costcategory'] ?? null });
          }

          const envelope = await client.request({
            administration,
            ...EP.costCategoryList,
            params: { status },
          });
          const payload = (envelope['settings'] ?? {}) as Record<string, unknown>;
          const categories = (payload['costcategories'] ?? []) as unknown[];
          return ok({ count: categories.length, costCategories: categories });
        }

        const envelope = await client.request({ administration, ...EP.settingsList });
        const settings = (envelope['settings'] ?? {}) as Record<string, unknown>;
        const tax = (settings['Tax'] ?? {}) as Record<string, unknown>;

        return ok({
          corporateIdentities: settings['CorporateIdentity'] ?? [],
          taxCodes: tax['Codes'] ?? {},
          taxRules: tax['Rules'] ?? {},
        });
      }),
  );
}
