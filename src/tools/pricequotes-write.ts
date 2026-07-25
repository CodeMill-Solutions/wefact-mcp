import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { guard } from './result.js';
import { administrationArg, confirmArg, dateArg, documentLineSchema, lineReferenceSchema } from './schemas.js';
import { SEX_VALUES } from './enums.js';
import { buildSelector, compact, gatedWrite } from './write-helpers.js';

/**
 * Price quotes (offertes) — write side, excluding sending (see pricequotes-send.ts).
 *
 * Endpoints:
 *   save_price_quote         → controller `pricequote`, actions `add` / `edit`
 *   manage_price_quote_lines → controller `pricequoteline` (add/delete) and `pricequote` (sortlines)
 *   set_price_quote_status   → controller `pricequote`, actions `accept` / `decline` / `archive`
 */
export function registerPriceQuoteWriteTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'save_price_quote',
    {
      description:
        'Create or update a price quote (offerte). ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default: it only writes ' +
        'when `confirm: true` is passed; otherwise it returns the exact body it would send. ' +
        '`action: "add"` requires a customer (`Debtor` id or `DebtorCode`) and at least one entry in ' +
        '`PriceQuoteLines`, and creates a CONCEPT — nothing is sent. Use send_price_quote_by_email to deliver it. ' +
        '`action: "edit"` requires `identifier` or `code`. ' +
        'As with invoices, a line needs only `ProductCode` and `Number`, or a free-text `Description` with ' +
        '`PriceExcl`. `Term` is the validity period in days. ' +
        'SAFETY: WeFact defaults `UseProductInventory` to "yes"; this tool defaults it to "no" so quoting never ' +
        'moves stock. Calls controller `pricequote`, actions `add` / `edit`.',
      inputSchema: {
        action: z.enum(['add', 'edit']).describe('"add" to create a new concept quote, "edit" to update one.'),
        identifier: z.number().int().positive().optional().describe('Price quote Identifier. Required for "edit".'),
        code: z.string().optional().describe('PriceQuoteCode, e.g. "OF2024-0001". Alternative lookup key for "edit".'),

        Debtor: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Customer Identifier. Required for "add" unless DebtorCode.'),
        DebtorCode: z
          .string()
          .optional()
          .describe('Customer number, e.g. "DB10000". Required for "add" unless Debtor.'),
        ExtraClientContactId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Address the quote to a specific extra contact. See get_debtor → ExtraClientContacts.'),

        PriceQuoteLines: z
          .array(documentLineSchema)
          .optional()
          .describe('Quote lines. Required for "add" (at least one).'),

        Date: dateArg.optional().describe('Quote date (YYYY-MM-DD). Defaults to today.'),
        Term: z.number().int().optional().describe('Validity in days.'),
        Description: z.string().optional().describe('Quote description shown to the customer.'),
        Comment: z.string().optional().describe('Internal note, not shown to the customer.'),
        ReferenceNumber: z.string().optional().describe("Your reference or the customer's reference."),

        Discount: z.number().min(0).max(100).optional().describe('Whole-quote discount PERCENTAGE (0–100).'),
        IgnoreDiscount: z.enum(['0', '1']).optional().describe('"1" to ignore the discount module. Default "0".'),
        VatCalcMethod: z
          .enum(['excl', 'incl'])
          .optional()
          .describe('Calculate VAT from exclusive or inclusive prices.'),
        UseProductInventory: z
          .enum(['yes', 'no'])
          .optional()
          .describe('Whether this quote touches product stock. WeFact defaults to "yes"; this tool defaults to "no".'),

        Status: z
          .number()
          .int()
          .optional()
          .describe('0 concept (default), 2 sent, 3 accepted, 4 invoiced, 8 declined.'),
        Archived: z.enum(['0', '1']).optional().describe('"1" to archive the quote.'),
        LanguageCode: z.string().optional().describe('Corporate identity / template, e.g. "nl_nl". See get_settings.'),
        Sent: z.number().int().optional().describe('Number of times sent (bookkeeping field).'),
        SentDate: dateArg.optional().describe('Send date (YYYY-MM-DD), a bookkeeping field.'),

        CompanyName: z.string().optional().describe('Override the customer company name snapshotted onto the quote.'),
        Initials: z.string().optional().describe('Override the first name.'),
        SurName: z.string().optional().describe('Override the last name.'),
        Sex: z.enum(SEX_VALUES).optional().describe('Override the salutation.'),
        Address: z.string().optional().describe('Override the street address.'),
        ZipCode: z.string().optional().describe('Override the postal code.'),
        City: z.string().optional().describe('Override the city.'),
        Country: z.string().optional().describe('Override the ISO country code.'),
        EmailAddress: z.string().optional().describe('Override the recipient email — where sending delivers to.'),

        PriceQuoteCode: z.string().optional().describe('Set an explicit quote number. Omit to let WeFact assign it.'),
        CustomFields: z.record(z.unknown()).optional().describe('Custom fields, keyed by field code.'),

        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ action, identifier, code, confirm, administration, ...fields }) =>
      guard(async () => {
        if (action === 'add') {
          if (fields.Debtor === undefined && !fields.DebtorCode) {
            throw new Error('Creating a price quote requires `Debtor` (id) or `DebtorCode`.');
          }
          if (!fields.PriceQuoteLines || fields.PriceQuoteLines.length === 0) {
            throw new Error('Creating a price quote requires at least one entry in `PriceQuoteLines`.');
          }
        }

        const selector = action === 'edit' ? buildSelector('PriceQuoteCode', { identifier, code }, 'price quote') : {};
        const body = {
          ...selector,
          ...compact(fields),
          UseProductInventory: fields.UseProductInventory ?? 'no',
        } as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: action === 'add' ? 'created' : 'updated',
          plannedKey: 'plannedPriceQuote',
          resultKey: 'priceQuote',
          body,
          extra: { action },
          execute: async () => {
            const envelope = await client.request({
              administration,
              ...(action === 'add' ? EP.priceQuoteAdd : EP.priceQuoteEdit),
              params: body,
            });
            return envelope['pricequote'] ?? null;
          },
        });
      }),
  );

  server.registerTool(
    'manage_price_quote_lines',
    {
      description:
        'Add, delete or reorder the lines of an existing price quote. ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default. ' +
        'For "add" pass `lines` as full line objects; for "delete" and "sort" pass objects carrying only ' +
        '`Identifier` (from get_price_quote). For "sort", the array order becomes the new line order. ' +
        'Calls controller `pricequoteline` (actions `add` / `delete`) and controller `pricequote` ' +
        '(action `sortlines`) — the same parent/child asymmetry as invoices.',
      inputSchema: {
        action: z.enum(['add', 'delete', 'sort']).describe('Which line operation to perform.'),
        identifier: z.number().int().positive().optional().describe('Price quote Identifier.'),
        code: z.string().optional().describe('PriceQuoteCode, e.g. "OF2024-0001". Use this or `identifier`.'),
        lines: z
          .array(z.union([documentLineSchema, lineReferenceSchema]))
          .min(1)
          .describe('For "add": full line objects. For "delete" and "sort": objects with just `Identifier`.'),
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ action, identifier, code, lines, administration, confirm }) =>
      guard(async () => {
        const selector = buildSelector('PriceQuoteCode', { identifier, code }, 'price quote');

        if (action !== 'add') {
          const missing = lines.findIndex((l) => (l as Record<string, unknown>)['Identifier'] === undefined);
          if (missing >= 0) {
            throw new Error(
              `Line ${missing + 1} has no \`Identifier\`. "${action}" needs the line ids from get_price_quote.`,
            );
          }
        }

        const endpoint =
          action === 'add'
            ? EP.priceQuoteLineAdd
            : action === 'delete'
              ? EP.priceQuoteLineDelete
              : EP.priceQuoteSortLines;

        const body = { ...selector, PriceQuoteLines: lines } as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: action === 'add' ? 'created' : action === 'delete' ? 'deleted' : 'updated',
          plannedKey: 'plannedLines',
          resultKey: 'priceQuote',
          body,
          extra: { action, lineCount: lines.length },
          ...(action === 'delete'
            ? { consequence: `${lines.length} line(s) will be permanently removed from the quote.` }
            : {}),
          execute: async () => {
            const envelope = await client.request({ administration, ...endpoint, params: body });
            return envelope['pricequote'] ?? envelope['success'] ?? null;
          },
        });
      }),
  );

  server.registerTool(
    'set_price_quote_status',
    {
      description:
        "Accept, decline or archive a price quote on the customer's behalf. " +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default. ' +
        '"accept" marks the quote accepted and, with `createInvoice: true`, ALSO CREATES A DRAFT INVOICE from it ' +
        '— the quote then reports status 4 (invoice created) rather than 3. ' +
        '"decline" marks it declined and archives it as a side effect. ' +
        '"archive" only works on quotes that are already accepted, invoiced or declined. ' +
        'None of these email the customer. Calls controller `pricequote`, actions `accept` / `decline` / `archive`.',
      inputSchema: {
        action: z.enum(['accept', 'decline', 'archive']).describe('Which status change to apply.'),
        identifier: z.number().int().positive().optional().describe('Price quote Identifier.'),
        code: z.string().optional().describe('PriceQuoteCode, e.g. "OF2024-0001". Use this or `identifier`.'),
        createInvoice: z
          .boolean()
          .optional()
          .describe('Only for "accept": also create a draft invoice from the quote. Default false.'),
        useQuoteCodeAsReference: z
          .boolean()
          .optional()
          .describe('Only for "accept" with createInvoice: put the quote number on the invoice as its reference.'),
        useTodayForLineDates: z
          .boolean()
          .optional()
          .describe('Only for "accept" with createInvoice: date the invoice lines today. WeFact defaults to true.'),
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({
      action,
      identifier,
      code,
      createInvoice,
      useQuoteCodeAsReference,
      useTodayForLineDates,
      administration,
      confirm,
    }) =>
      guard(async () => {
        const selector = buildSelector('PriceQuoteCode', { identifier, code }, 'price quote');

        const endpoint =
          action === 'accept'
            ? EP.priceQuoteAccept
            : action === 'decline'
              ? EP.priceQuoteDecline
              : EP.priceQuoteArchive;

        const yesNo = (v: boolean | undefined): string | undefined => (v === undefined ? undefined : v ? 'yes' : 'no');

        const body = compact({
          ...selector,
          ...(action === 'accept'
            ? {
                CreateInvoice: yesNo(createInvoice),
                // WeFact spells this parameter with a capitalised "AS" — send it verbatim.
                UsePriceQuoteCodeASInvoiceReference: yesNo(useQuoteCodeAsReference),
                UseTodayAsInvoiceLinesDate: yesNo(useTodayForLineDates),
              }
            : {}),
        }) as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: 'updated',
          plannedKey: 'plannedStatusChange',
          resultKey: 'result',
          body,
          extra: { action },
          consequence:
            action === 'accept'
              ? createInvoice
                ? 'The quote will be accepted AND a draft invoice created from it.'
                : 'The quote will be marked as accepted.'
              : action === 'decline'
                ? 'The quote will be marked as declined and archived.'
                : 'The quote will be archived.',
          execute: async () => {
            const envelope = await client.request({ administration, ...endpoint, params: body });
            return {
              priceQuote: envelope['pricequote'] ?? null,
              invoice: envelope['invoice'] ?? null,
              messages: envelope['success'] ?? [],
            };
          },
        });
      }),
  );
}
