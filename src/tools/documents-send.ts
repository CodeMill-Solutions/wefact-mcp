import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { guard } from './result.js';
import { administrationArg, confirmArg, dateTimeArg } from './schemas.js';
import { buildSelector, gatedWrite } from './write-helpers.js';

/**
 * Scheduling a document to be sent automatically at a future moment.
 *
 * This arms a DELAYED real send, so it sits behind the same `WEFACT_ALLOW_SEND`
 * gate as the immediate send tools. Cancelling is possible right up until the
 * scheduled moment; afterwards the email has left and only crediting (invoices)
 * remains.
 *
 * Endpoints:
 *   schedule_document_send → controller `invoice` / `pricequote`,
 *                            actions `schedule` / `cancelschedule`
 */
export function registerDocumentSendTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'schedule_document_send',
    {
      description:
        'THIS ARMS A REAL EMAIL TO THE CUSTOMER at a future moment, or cancels one already armed. ' +
        'WRITE TOOL — needs BOTH WEFACT_ALLOW_WRITES=true and WEFACT_ALLOW_SEND=true, and stays in dry-run until ' +
        '`confirm: true` is passed. ' +
        '`action: "schedule"` requires `sendAt` ("YYYY-MM-DD HH:MM:SS") and works on DRAFT/CONCEPT documents only. ' +
        'When the moment arrives WeFact emails the document exactly as send_invoice_by_email would — including, ' +
        'for invoices, finalising it and assigning its permanent number. If the document is set to be delivered by ' +
        'post, WeFact instead notifies you to send it manually. ' +
        '`action: "cancel"` disarms a scheduled send; it only helps before the scheduled moment. ' +
        'Note the WeFact action is `cancelschedule`, without the hyphen its documentation URL uses. ' +
        'Calls controller `invoice` / `pricequote`, actions `schedule` / `cancelschedule`.',
      inputSchema: {
        action: z.enum(['schedule', 'cancel']).describe('Arm a scheduled send, or cancel one.'),
        type: z.enum(['invoice', 'pricequote']).describe('Which kind of document to schedule.'),
        identifier: z.number().int().positive().optional().describe('Document Identifier.'),
        code: z.string().optional().describe('InvoiceCode or PriceQuoteCode. Use this or `identifier`.'),
        sendAt: dateTimeArg
          .optional()
          .describe('When to send, as "YYYY-MM-DD HH:MM:SS". Required for action "schedule".'),
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ action, type, identifier, code, sendAt, administration, confirm }) =>
      guard(async () => {
        if (action === 'schedule' && !sendAt) {
          throw new Error('`sendAt` is required when action is "schedule", e.g. "2026-08-01 09:00:00".');
        }

        const codeField = type === 'invoice' ? 'InvoiceCode' : 'PriceQuoteCode';
        const entity = type === 'invoice' ? 'invoice' : 'price quote';
        const selector = buildSelector(codeField, { identifier, code }, entity);

        const endpoint =
          type === 'invoice'
            ? action === 'schedule'
              ? EP.invoiceSchedule
              : EP.invoiceCancelSchedule
            : action === 'schedule'
              ? EP.priceQuoteSchedule
              : EP.priceQuoteCancelSchedule;

        const body = {
          ...selector,
          ...(action === 'schedule' ? { ScheduledAt: sendAt } : {}),
        } as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: 'updated',
          requiresSend: true,
          plannedKey: 'plannedSchedule',
          resultKey: 'result',
          body,
          extra: { action, type },
          consequence:
            action === 'schedule'
              ? `The ${entity} will be emailed to the customer automatically at ${sendAt}` +
                (type === 'invoice' ? ', which will also finalise it and assign its permanent number.' : '.')
              : `The armed automatic send for this ${entity} will be cancelled.`,
          execute: async () => {
            const envelope = await client.request({ administration, ...endpoint, params: body });
            return {
              document: envelope['invoice'] ?? envelope['pricequote'] ?? null,
              messages: envelope['success'] ?? [],
            };
          },
        });
      }),
  );
}
