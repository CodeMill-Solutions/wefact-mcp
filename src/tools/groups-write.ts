import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { guard } from './result.js';
import { administrationArg, confirmArg } from './schemas.js';
import { compact, gatedWrite } from './write-helpers.js';

/**
 * Groups (groepen) — write side.
 *
 * Endpoints:
 *   manage_group → controller `group`, actions `add` / `edit` / `delete`
 */
export function registerGroupWriteTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'manage_group',
    {
      description:
        'Create, edit or delete a customer group or product group. ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default. ' +
        '`action: "add"` requires `type` and `groupName`; `edit` and `delete` require `identifier`. ' +
        'CAUTION on edit: `items` REPLACES the membership wholesale — any id you leave out is unlinked from the ' +
        'group. Read the current members with list_groups and send the full set. ' +
        '`type` cannot be changed after creation. Calls controller `group`, actions `add` / `edit` / `delete`.',
      inputSchema: {
        action: z.enum(['add', 'edit', 'delete']).describe('Which operation to perform.'),
        identifier: z.number().int().positive().optional().describe('Group id. Required for "edit" and "delete".'),
        type: z.enum(['debtor', 'product']).optional().describe('Group kind. Required for "add"; not editable after.'),
        groupName: z.string().optional().describe('Group name. Required for "add".'),
        items: z
          .array(z.number().int())
          .optional()
          .describe('Full list of member ids (debtor or product Identifiers). On edit this REPLACES the membership.'),
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ action, identifier, type, groupName, items, administration, confirm }) =>
      guard(async () => {
        if (action === 'add') {
          if (!type || !groupName) throw new Error('Creating a group requires both `type` and `groupName`.');
        } else if (identifier === undefined) {
          throw new Error(`\`identifier\` is required when action is "${action}".`);
        }

        const endpoint = action === 'add' ? EP.groupAdd : action === 'edit' ? EP.groupEdit : EP.groupDelete;

        const body = compact({
          // WeFact rejects a stray Identifier on `add`.
          Identifier: action === 'add' ? undefined : identifier,
          Type: action === 'add' ? type : undefined,
          GroupName: groupName,
          Items: items,
        }) as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: action === 'add' ? 'created' : action === 'edit' ? 'updated' : 'deleted',
          plannedKey: 'plannedGroup',
          resultKey: 'group',
          body,
          extra: { action },
          ...(action === 'delete'
            ? { consequence: 'The group will be permanently deleted. Its members are not deleted, only unlinked.' }
            : action === 'edit' && items !== undefined
              ? { consequence: `Group membership will be replaced with exactly these ${items.length} member(s).` }
              : {}),
          execute: async () => {
            const envelope = await client.request({ administration, ...endpoint, params: body });
            return envelope['group'] ?? envelope['success'] ?? null;
          },
        });
      }),
  );
}
