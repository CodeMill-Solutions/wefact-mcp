import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { guard } from './result.js';
import { administrationArg, confirmArg, dateArg } from './schemas.js';
import { COMMUNICATION_METHODS, TASK_STATUSES } from './enums.js';
import { compact, gatedWrite } from './write-helpers.js';

/**
 * CRM: tasks (taken) and interactions (interacties) — write side.
 *
 * Neither entity has a delete action, so records created here are permanent —
 * a task can only be completed, not removed.
 *
 * Endpoints:
 *   save_crm_record → controller `task` / `interaction`, actions `add` / `edit`,
 *                     plus controller `task`, action `changestatus`
 */
export function registerCrmWriteTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'save_crm_record',
    {
      description:
        'Create or update a CRM task (taak) or interaction (interactie — a logged call, email or meeting), or ' +
        "change a task's status. " +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default. ' +
        'For a task, `action: "add"` needs only `title`; use `dueDate` with `hours`/`minutes` for a deadline and ' +
        '`assigneeId` to assign it. `action: "status"` is the shortcut for completing a task and needs `status`. ' +
        'For an interaction, `action: "add"` needs `assigneeId`, `description`, `communicationMethod` AND at least ' +
        'one link field (debtorId, creditorId, invoiceId, priceQuoteId, creditInvoiceId or subscriptionId). ' +
        'NOTE: neither tasks nor interactions can be deleted through the WeFact API — a task is closed by setting ' +
        'its status to "completed". ' +
        'Calls controller `task` / `interaction`, actions `add` / `edit` / `changestatus`.',
      inputSchema: {
        type: z.enum(['task', 'interaction']).describe('Which CRM entity to write.'),
        action: z
          .enum(['add', 'edit', 'status'])
          .describe('"add", "edit", or "status" to change a task status (tasks only).'),
        identifier: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Record Identifier. Required for "edit" and "status".'),

        title: z.string().optional().describe('Task title. Required when adding a task.'),
        description: z.string().optional().describe('Description. Required when adding an interaction.'),
        status: z.enum(TASK_STATUSES).optional().describe('Task status. Required for action "status".'),
        communicationMethod: z
          .enum(COMMUNICATION_METHODS)
          .optional()
          .describe('How the interaction happened. Required when adding an interaction.'),

        dueDate: dateArg.optional().describe('Task due date, or interaction date (YYYY-MM-DD).'),
        hours: z.string().optional().describe('Hour part of the time, e.g. "14".'),
        minutes: z.string().optional().describe('Minute part of the time, e.g. "30".'),
        assigneeId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Employee the record is assigned to. Required when adding an interaction.'),

        debtorId: z.number().int().positive().optional().describe('Link to a customer.'),
        debtorContactId: z.number().int().positive().optional().describe('Link to a customer contact person.'),
        creditorId: z.number().int().positive().optional().describe('Link to a supplier.'),
        invoiceId: z.number().int().positive().optional().describe('Link to a sales invoice.'),
        priceQuoteId: z.number().int().positive().optional().describe('Link to a price quote.'),
        creditInvoiceId: z.number().int().positive().optional().describe('Link to a purchase invoice.'),
        unprocessedCreditInvoiceId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Link to an unprocessed purchase invoice.'),
        subscriptionId: z.number().int().positive().optional().describe('Link to a subscription.'),

        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ type, action, identifier, administration, confirm, ...fields }) =>
      guard(async () => {
        if (action === 'status') {
          if (type !== 'task') throw new Error('Action "status" applies to tasks only.');
          if (identifier === undefined) throw new Error('`identifier` is required for action "status".');
          if (!fields.status) throw new Error('`status` is required for action "status".');
        } else if (action === 'edit') {
          if (identifier === undefined) throw new Error('`identifier` is required when action is "edit".');
        } else if (type === 'task') {
          if (!fields.title) throw new Error('Creating a task requires `title`.');
        } else {
          const missing: string[] = [];
          if (fields.assigneeId === undefined) missing.push('assigneeId');
          if (!fields.description) missing.push('description');
          if (!fields.communicationMethod) missing.push('communicationMethod');
          if (missing.length > 0) throw new Error(`Creating an interaction requires ${missing.join(', ')}.`);

          const links = [
            fields.debtorId,
            fields.creditorId,
            fields.invoiceId,
            fields.priceQuoteId,
            fields.creditInvoiceId,
            fields.unprocessedCreditInvoiceId,
            fields.subscriptionId,
          ];
          if (links.every((l) => l === undefined)) {
            throw new Error(
              'Creating an interaction requires at least one link: debtorId, creditorId, invoiceId, priceQuoteId, ' +
                'creditInvoiceId, unprocessedCreditInvoiceId or subscriptionId.',
            );
          }
        }

        const endpoint =
          action === 'status'
            ? EP.taskChangeStatus
            : type === 'task'
              ? action === 'add'
                ? EP.taskAdd
                : EP.taskEdit
              : action === 'add'
                ? EP.interactionAdd
                : EP.interactionEdit;

        const body =
          action === 'status'
            ? ({ Identifier: identifier, Status: fields.status } as Record<string, unknown>)
            : (compact({
                // WeFact rejects a stray Identifier on `add`: "Een Identifier is
                // niet toegestaan voor deze actie."
                Identifier: action === 'add' ? undefined : identifier,
                Title: fields.title,
                Description: fields.description,
                Status: type === 'task' ? fields.status : undefined,
                CommunicationMethod: type === 'interaction' ? fields.communicationMethod : undefined,
                [type === 'task' ? 'DueAt' : 'Date']: fields.dueDate,
                Hours: fields.hours,
                Minutes: fields.minutes,
                AssigneeId: fields.assigneeId,
                DebtorId: fields.debtorId,
                DebtorContactId: fields.debtorContactId,
                CreditorId: fields.creditorId,
                InvoiceId: fields.invoiceId,
                PriceQuoteId: fields.priceQuoteId,
                CreditInvoiceId: fields.creditInvoiceId,
                UnprocessedCreditInvoiceId: fields.unprocessedCreditInvoiceId,
                SubscriptionId: fields.subscriptionId,
              }) as Record<string, unknown>);

        return gatedWrite({
          confirm,
          statusKey: action === 'add' ? 'created' : 'updated',
          plannedKey: 'plannedRecord',
          resultKey: type,
          body,
          extra: { type, action },
          execute: async () => {
            const envelope = await client.request({ administration, ...endpoint, params: body });
            return envelope[type] ?? envelope['success'] ?? null;
          },
        });
      }),
  );
}
