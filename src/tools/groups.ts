import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { ok, guard } from './result.js';
import { administrationArg } from './schemas.js';

/**
 * Groups (groepen) — customer groups and product groups share one controller.
 *
 * `group/list` requires a `type` (verified: omitting it is an error), and the
 * controller has no search or date filters, so the shared list parameter block
 * does not apply here.
 *
 * Endpoints:
 *   list_groups → controller `group`, actions `list` / `show`
 */
export function registerGroupTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'list_groups',
    {
      description:
        'List customer groups or product groups, including their member ids. `type` is REQUIRED — WeFact rejects ' +
        'the call without it. Pass `identifier` to read a single group instead of the whole list. ' +
        'The ids returned here are what list_debtors and list_products accept as `groupId`, and what ' +
        'save_debtor and save_product accept in `Groups`. ' +
        'This controller supports only offset/limit — no sorting, searching or date filtering. ' +
        'Calls controller `group`, actions `list` / `show`.',
      inputSchema: {
        type: z.enum(['debtor', 'product']).describe('Which kind of group to list. Required.'),
        identifier: z.number().int().positive().optional().describe('Read a single group by id instead of listing.'),
        offset: z.number().int().min(0).optional().describe('Row offset (default 0).'),
        limit: z.number().int().min(1).max(1000).optional().describe('Rows to return (default 1000).'),
        administration: administrationArg,
      },
    },
    async ({ type, identifier, offset, limit, administration }) =>
      guard(async () => {
        if (identifier !== undefined) {
          const envelope = await client.request({
            administration,
            ...EP.groupShow,
            params: { Identifier: identifier },
          });
          return ok({ group: envelope['group'] ?? null });
        }

        const envelope = await client.request({
          administration,
          ...EP.groupList,
          params: { type, offset, limit },
        });
        const groups = (envelope['groups'] ?? []) as unknown[];
        return ok({ count: groups.length, totalResults: envelope['totalresults'] ?? groups.length, groups });
      }),
  );
}
