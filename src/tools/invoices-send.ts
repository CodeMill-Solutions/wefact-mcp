import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { guard } from './result.js';
import { administrationArg, confirmArg } from './schemas.js';
import { buildSelector, gatedWrite } from './write-helpers.js';

/**
 * Sales invoice delivery — the tools that send real email to a customer.
 *
 * These are kept in their own module, behind their own env gate
 * (`WEFACT_ALLOW_SEND` on top of `WEFACT_ALLOW_WRITES`), because they are the
 * only invoice operations whose effect leaves the building and cannot be walked
 * back. `sendbyemail` additionally finalises the draft and burns an invoice
 * number.
 *
 * There are no template, recipient or subject parameters: WeFact drives
 * delivery entirely from data already on the invoice (EmailAddress,
 * InvoiceMethod, LanguageCode, ExtraClientContactId). To change any of those,
 * edit the invoice first with save_invoice.
 *
 * Endpoints:
 *   send_invoice_by_email  → controller `invoice`, action `sendbyemail`
 *   send_invoice_reminder  → controller `invoice`,
 *                            actions `sendreminderbyemail` / `sendsummationbyemail`
 */
export function registerInvoiceSendTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'send_invoice_by_email',
    {
      description:
        'THIS SENDS A REAL EMAIL TO THE CUSTOMER. Deliver a sales invoice by email (or via Peppol when the ' +
        'invoice is set to InvoiceMethod 5). ' +
        'WRITE TOOL — needs BOTH WEFACT_ALLOW_WRITES=true and WEFACT_ALLOW_SEND=true, and stays in dry-run until ' +
        '`confirm: true` is passed. ' +
        'IRREVERSIBLE: besides emailing the customer, this finalises a draft — the placeholder "[concept]0001" is ' +
        'replaced by a permanent invoice number, the status becomes sent, and a PaymentURL is generated. ' +
        "There is no template or recipient argument: the invoice's own EmailAddress, InvoiceMethod and " +
        'LanguageCode decide where and how it goes, so check them with get_invoice and change them with ' +
        'save_invoice BEFORE calling this. Calls controller `invoice`, action `sendbyemail`.',
      inputSchema: {
        identifier: z.number().int().positive().optional().describe('Invoice Identifier.'),
        code: z.string().optional().describe('InvoiceCode, e.g. "F2024-0001". Use this or `identifier`.'),
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ identifier, code, administration, confirm }) =>
      guard(async () => {
        const body = buildSelector('InvoiceCode', { identifier, code }, 'invoice');

        return gatedWrite({
          confirm,
          statusKey: 'sent',
          requiresSend: true,
          plannedKey: 'plannedSend',
          resultKey: 'invoice',
          body,
          consequence:
            'The invoice will be emailed to the address on the invoice, finalised, and given its permanent ' +
            'invoice number. The email cannot be recalled.',
          execute: async () => {
            const envelope = await client.request({ administration, ...EP.invoiceSendByEmail, params: body });
            return {
              invoice: envelope['invoice'] ?? null,
              messages: envelope['success'] ?? [],
              warnings: envelope['warning'] ?? [],
            };
          },
        });
      }),
  );

  server.registerTool(
    'send_invoice_reminder',
    {
      description:
        'THIS SENDS A REAL DUNNING EMAIL TO THE CUSTOMER. Chase an unpaid invoice with either a friendly reminder ' +
        '(herinnering) or a formal demand (aanmaning). ' +
        'WRITE TOOL — needs BOTH WEFACT_ALLOW_WRITES=true and WEFACT_ALLOW_SEND=true, and stays in dry-run until ' +
        '`confirm: true` is passed. ' +
        '`level: "reminder"` is the gentler first step; `level: "summation"` is the formal escalation. Each call ' +
        "increments the invoice's Reminders or Summations counter and stamps the corresponding date, so calling " +
        'twice chases the customer twice. Check the current counters with get_invoice first. ' +
        "The recipient is the invoice's ReminderEmailAddress if the customer has one, otherwise its EmailAddress. " +
        'Calls controller `invoice`, actions `sendreminderbyemail` / `sendsummationbyemail`.',
      inputSchema: {
        level: z
          .enum(['reminder', 'summation'])
          .describe('"reminder" for a payment reminder, "summation" for a formal demand.'),
        identifier: z.number().int().positive().optional().describe('Invoice Identifier.'),
        code: z.string().optional().describe('InvoiceCode, e.g. "F2024-0001". Use this or `identifier`.'),
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ level, identifier, code, administration, confirm }) =>
      guard(async () => {
        const body = buildSelector('InvoiceCode', { identifier, code }, 'invoice');
        const endpoint = level === 'reminder' ? EP.invoiceSendReminder : EP.invoiceSendSummation;

        return gatedWrite({
          confirm,
          statusKey: 'sent',
          requiresSend: true,
          plannedKey: 'plannedSend',
          resultKey: 'result',
          body,
          extra: { level },
          consequence:
            `A ${level === 'reminder' ? 'payment reminder' : 'formal demand'} will be emailed to the customer and ` +
            'the invoice counter incremented. The email cannot be recalled.',
          execute: async () => {
            const envelope = await client.request({ administration, ...endpoint, params: body });
            return { messages: envelope['success'] ?? [], warnings: envelope['warning'] ?? [] };
          },
        });
      }),
  );
}
