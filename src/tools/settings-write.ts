import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { guard } from './result.js';
import { administrationArg, confirmArg } from './schemas.js';
import { compact, gatedWrite } from './write-helpers.js';

/**
 * Cost categories (kostencategorieën) — write side.
 *
 * Endpoints:
 *   manage_cost_category → controller `settings`,
 *                          actions `costcategory_add` / `costcategory_edit` / `costcategory_delete`
 */
export function registerSettingsWriteTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'manage_cost_category',
    {
      description:
        'Create, rename or remove a cost category — the classification purchase-invoice lines are booked against. ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default: it only writes ' +
        'when `confirm: true` is passed; otherwise it returns the exact body it would send. ' +
        '`action: "add"` needs `title`; `edit` and `delete` need `identifier`. Deleting is a soft delete — the ' +
        'category is set to status "removed" so it can no longer be used for new bookings, and existing bookings ' +
        'keep it. Note that WeFact only shows the change in its own UI after you log out and back in. ' +
        'Calls controller `settings`, actions `costcategory_add` / `costcategory_edit` / `costcategory_delete`.',
      inputSchema: {
        action: z.enum(['add', 'edit', 'delete']).describe('Which operation to perform.'),
        identifier: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Cost category id. Required for "edit" and "delete". From get_settings(section:"cost_categories").',
          ),
        title: z.string().optional().describe('Cost category name. Required for "add".'),
        status: z.enum(['active', 'removed']).optional().describe('Set the status directly when editing.'),
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ action, identifier, title, status, administration, confirm }) =>
      guard(async () => {
        if (action === 'add' && !title) {
          throw new Error('`title` is required when action is "add".');
        }
        if (action !== 'add' && identifier === undefined) {
          throw new Error(`\`identifier\` is required when action is "${action}".`);
        }

        const endpoint =
          action === 'add' ? EP.costCategoryAdd : action === 'edit' ? EP.costCategoryEdit : EP.costCategoryDelete;

        const body = compact({
          // WeFact rejects a stray Identifier on `add`.
          Identifier: action === 'add' ? undefined : identifier,
          Title: title,
          Status: status,
        }) as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: action === 'add' ? 'created' : action === 'edit' ? 'updated' : 'deleted',
          plannedKey: 'plannedCostCategory',
          resultKey: 'costCategory',
          body,
          extra: { action },
          ...(action === 'delete'
            ? { consequence: 'The cost category will be set to "removed" and can no longer be used for new bookings.' }
            : {}),
          execute: async () => {
            const envelope = await client.request({ administration, ...endpoint, params: body });
            const payload = (envelope['settings'] ?? {}) as Record<string, unknown>;
            return payload['costcategory'] ?? envelope['success'] ?? null;
          },
        });
      }),
  );
}
