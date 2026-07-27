import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { ok, guard } from './result.js';
import { administrationArg } from './schemas.js';
import { CRM_REFERENCE_TYPES, TASK_STATUSES } from './enums.js';

/**
 * CRM: tasks (taken) and interactions (interacties) — read side.
 *
 * The two entities share a shape closely enough to share tools, with one sharp
 * difference worth guarding: `interaction/list` REQUIRES referenceId +
 * referenceType (verified), so there is no way to list all interactions the way
 * you can list all tasks.
 *
 * Endpoints:
 *   list_crm_records → controller `task` / `interaction`, action `list`
 *   get_crm_record   → controller `task` / `interaction`, action `show`
 */
export function registerCrmTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'list_crm_records',
    {
      description:
        'List CRM tasks (taken) or interactions (interacties — logged calls, emails and meetings). ' +
        'IMPORTANT ASYMMETRY: `type: "interaction"` REQUIRES both `referenceId` and `referenceType` — WeFact ' +
        'cannot list all interactions, only those attached to one specific record. Tasks can be listed freely, ' +
        'and optionally filtered the same way, including `referenceType: "unlinked"` for tasks attached to nothing. ' +
        'Tasks also support `status` ("open", "in_progress", "completed"). ' +
        'Tasks sort by due date and search "Title|Description"; interactions sort by date and search "Description". ' +
        'Auto-paginated. Calls controller `task` / `interaction`, action `list`.',
      inputSchema: {
        type: z.enum(['task', 'interaction']).describe('Which CRM entity to list.'),
        referenceId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Id of the linked record. REQUIRED for interactions.'),
        referenceType: z
          .enum([...CRM_REFERENCE_TYPES, 'unlinked'])
          .optional()
          .describe('Kind of linked record. REQUIRED for interactions. "unlinked" is tasks-only.'),
        status: z.enum(TASK_STATUSES).optional().describe('Task status filter. Tasks only.'),
        searchfor: z.string().optional().describe('Value to search for.'),
        searchat: z
          .string()
          .optional()
          .describe(
            'Pipe-separated fields to search in. Tasks default to "Title|Description", interactions to "Description".',
          ),
        sort: z.string().optional().describe('Field to sort on. Tasks default to "DueAtDate", interactions to "Date".'),
        order: z.enum(['ASC', 'DESC']).optional().describe('Sort direction. Defaults to DESC.'),
        maxItems: z.number().int().positive().optional().describe('Cap on total rows returned (default 1000).'),
        administration: administrationArg,
      },
    },
    async ({ type, referenceId, referenceType, status, maxItems, administration, ...rest }) =>
      guard(async () => {
        if (type === 'interaction' && (referenceId === undefined || !referenceType)) {
          throw new Error(
            'Listing interactions requires BOTH `referenceId` and `referenceType` — WeFact cannot list all ' +
              'interactions. For example referenceType: "debtor", referenceId: 123.',
          );
        }
        if (referenceType === 'unlinked' && type === 'interaction') {
          throw new Error('`referenceType: "unlinked"` applies to tasks only.');
        }

        const controller = type === 'task' ? 'task' : 'interaction';
        const itemsKey = type === 'task' ? 'tasks' : 'interactions';

        const { items, totalResults, truncated } = await client.paginate<Record<string, unknown>>(controller, {
          administration,
          itemsKey,
          maxItems,
          params: {
            referenceId,
            referenceType,
            status: type === 'task' ? status : undefined,
            ...rest,
          },
        });

        return ok({ count: items.length, totalResults, truncated, [itemsKey]: items });
      }),
  );

  server.registerTool(
    'get_crm_record',
    {
      description:
        'Read one CRM task or interaction in full, including its comments and attachments and every link field ' +
        '(DebtorId, CreditorId, InvoiceId, PriceQuoteId, CreditInvoiceId, SubscriptionId). ' +
        'Tasks add DueAt/DueAtTime, AssigneeId, Status and CompletedAt; interactions add Date/Time and ' +
        'CommunicationMethod. An unset CompletedAt or Date may come back as a zero date like "0000-00-00". ' +
        'REQUIRES the numeric `identifier` — neither entity has a code. ' +
        'Calls controller `task` / `interaction`, action `show`.',
      inputSchema: {
        type: z.enum(['task', 'interaction']).describe('Which CRM entity to read.'),
        identifier: z.number().int().positive().describe('Task or interaction Identifier.'),
        administration: administrationArg,
      },
    },
    async ({ type, identifier, administration }) =>
      guard(async () => {
        const envelope = await client.request({
          administration,
          ...(type === 'task' ? EP.taskShow : EP.interactionShow),
          params: { Identifier: identifier },
        });
        return ok({ [type]: envelope[type] ?? null });
      }),
  );
}
