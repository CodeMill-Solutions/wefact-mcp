import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { guard } from './result.js';
import { administrationArg, confirmArg } from './schemas.js';
import { buildSelector, gatedWrite } from './write-helpers.js';

/**
 * Price quote delivery — sends real email to a customer, so it lives behind the
 * `WEFACT_ALLOW_SEND` gate in its own module.
 *
 * Unlike invoices, sending a quote does not finalise a number; it does publish
 * the customer-facing AcceptURL, which is how a quote gets accepted online.
 *
 * Endpoints:
 *   send_price_quote_by_email → controller `pricequote`, action `sendbyemail`
 */
export function registerPriceQuoteSendTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'send_price_quote_by_email',
    {
      description:
        'THIS SENDS A REAL EMAIL TO THE CUSTOMER. Deliver a price quote (offerte) by email. ' +
        'WRITE TOOL — needs BOTH WEFACT_ALLOW_WRITES=true and WEFACT_ALLOW_SEND=true, and stays in dry-run until ' +
        '`confirm: true` is passed. ' +
        'Side effects: the quote moves to status "sent", its Sent counter and SentDate are updated, and its ' +
        'AcceptURL is published — from that point the customer can accept the quote online, which may in turn ' +
        'create an invoice. The email cannot be recalled. ' +
        "There is no template or recipient argument: the quote's own EmailAddress, PriceQuoteMethod and " +
        'LanguageCode decide where and how it goes, so verify them with get_price_quote and change them with ' +
        'save_price_quote BEFORE calling this. ' +
        'Note there is no equivalent for purchase invoices — WeFact has no creditinvoice/sendbyemail action. ' +
        'Calls controller `pricequote`, action `sendbyemail`.',
      inputSchema: {
        identifier: z.number().int().positive().optional().describe('Price quote Identifier.'),
        code: z.string().optional().describe('PriceQuoteCode, e.g. "OF2024-0001". Use this or `identifier`.'),
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ identifier, code, administration, confirm }) =>
      guard(async () => {
        const body = buildSelector('PriceQuoteCode', { identifier, code }, 'price quote');

        return gatedWrite({
          confirm,
          statusKey: 'sent',
          requiresSend: true,
          plannedKey: 'plannedSend',
          resultKey: 'priceQuote',
          body,
          consequence:
            'The quote will be emailed to the address on the quote and its online AcceptURL published. ' +
            'The email cannot be recalled.',
          execute: async () => {
            const envelope = await client.request({ administration, ...EP.priceQuoteSendByEmail, params: body });
            return {
              priceQuote: envelope['pricequote'] ?? null,
              messages: envelope['success'] ?? [],
              warnings: envelope['warning'] ?? [],
            };
          },
        });
      }),
  );
}
