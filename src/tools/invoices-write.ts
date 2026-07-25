import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { guard } from './result.js';
import {
  administrationArg,
  confirmArg,
  dateArg,
  dateTimeArg,
  documentLineSchema,
  lineReferenceSchema,
} from './schemas.js';
import { PAYMENT_METHODS, SEX_VALUES } from './enums.js';
import { buildSelector, compact, gatedWrite } from './write-helpers.js';

/**
 * Sales invoices (facturen) — write side, excluding anything that emails a
 * customer. Those live in invoices-send.ts.
 *
 * Endpoints:
 *   save_invoice          → controller `invoice`, actions `add` / `edit`
 *   manage_invoice_lines  → controller `invoiceline` (add/delete) and `invoice` (sortlines)
 *   register_payment      → controller `invoice` / `creditinvoice`,
 *                           actions `partpayment` / `markaspaid` / `markasunpaid`
 *   credit_invoice        → controller `invoice`, action `credit`
 *   set_invoice_state     → controller `invoice`, actions `block` / `unblock` /
 *                           `paymentprocesspause` / `paymentprocessreactivate`
 */
export function registerInvoiceWriteTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'save_invoice',
    {
      description:
        'Create or update a sales invoice (factuur). ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default: it only writes ' +
        'when `confirm: true` is passed; otherwise it returns the exact body it would send. ' +
        '`action: "add"` requires a customer (`Debtor` id or `DebtorCode`) and at least one entry in ' +
        '`InvoiceLines`, and creates a DRAFT — it sends nothing and assigns no real invoice number. Use ' +
        'send_invoice_by_email to actually deliver it. `action: "edit"` requires `identifier` or `code`. ' +
        'A line needs only `ProductCode` and `Number`, or a free-text `Description` with `PriceExcl`; supplying a ' +
        'ProductCode auto-fills description, price, VAT code and recurrence from the product. ' +
        'SAFETY: WeFact defaults `UseProductInventory` to "yes", which decrements stock. This tool defaults it to ' +
        '"no" — pass "yes" explicitly when the invoice really should move inventory. ' +
        'For line-level surgery on an existing invoice prefer manage_invoice_lines; passing `InvoiceLines` to ' +
        '"edit" has ambiguous merge semantics. Calls controller `invoice`, actions `add` / `edit`.',
      inputSchema: {
        action: z.enum(['add', 'edit']).describe('"add" to create a new draft invoice, "edit" to update one.'),
        identifier: z.number().int().positive().optional().describe('Invoice Identifier. Required for "edit".'),
        code: z.string().optional().describe('InvoiceCode, e.g. "F2024-0001". Alternative lookup key for "edit".'),

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
          .describe('Address the invoice to a specific extra contact. See get_debtor → ExtraClientContacts.'),

        InvoiceLines: z
          .array(documentLineSchema)
          .optional()
          .describe('Invoice lines. Required for "add" (at least one).'),

        Date: dateArg.optional().describe('Invoice date (YYYY-MM-DD). Defaults to today.'),
        Term: z
          .number()
          .int()
          .optional()
          .describe('Payment term in days. Defaults to the customer or administration setting.'),
        Description: z.string().optional().describe('Invoice description shown to the customer.'),
        Comment: z.string().optional().describe('Internal note, not shown to the customer.'),
        ReferenceNumber: z.string().optional().describe("Your reference or the customer's purchase order number."),

        Discount: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('Whole-invoice discount PERCENTAGE (0–100), not an amount.'),
        IgnoreDiscount: z.enum(['0', '1']).optional().describe('"1" to ignore the discount module. Default "0".'),
        VatCalcMethod: z
          .enum(['excl', 'incl'])
          .optional()
          .describe('Whether line prices are VAT-exclusive or VAT-inclusive. Defaults to the administration setting.'),
        UseProductInventory: z
          .enum(['yes', 'no'])
          .optional()
          .describe(
            'Whether creating this invoice decrements product stock. WeFact defaults to "yes"; this tool defaults ' +
              'to "no" so invoicing never silently moves inventory. Pass "yes" deliberately.',
          ),

        Status: z
          .number()
          .int()
          .optional()
          .describe(
            'Invoice status: 0 draft (default), 2 sent, 3 partly paid, 4 paid, 8 credit, 9 expired. Setting 2 ' +
              'records the invoice as sent for bookkeeping WITHOUT emailing anyone.',
          ),
        SubStatus: z
          .string()
          .optional()
          .describe('"BLOCKED" to block a draft, "PAUSED" to pause the payment process. See set_invoice_state.'),
        InvoiceMethod: z.number().int().optional().describe('Delivery: 0 email, 1 post, 3 both, 5 Peppol.'),
        LanguageCode: z.string().optional().describe('Corporate identity / template, e.g. "nl_nl". See get_settings.'),
        Sent: z.number().int().optional().describe('Number of times the invoice has been sent (bookkeeping field).'),
        SentDate: dateTimeArg.optional().describe('Send date ("YYYY-MM-DD HH:MM:SS"), a bookkeeping field.'),

        PaymentMethod: z.enum(PAYMENT_METHODS).optional().describe('How the invoice was paid. Default "wire".'),
        PayDate: dateArg.optional().describe('Payment date (YYYY-MM-DD).'),
        AmountPaid: z
          .number()
          .optional()
          .describe('Amount already paid. For real payments use register_payment instead — this only sets the field.'),
        TransactionID: z.string().optional().describe('Transaction id of an online payment.'),
        Authorisation: z.enum(['yes', 'no']).optional().describe('Collect by direct debit.'),

        CompanyName: z.string().optional().describe('Override the customer company name snapshotted onto the invoice.'),
        Initials: z.string().optional().describe('Override the first name.'),
        SurName: z.string().optional().describe('Override the last name.'),
        Sex: z.enum(SEX_VALUES).optional().describe('Override the salutation.'),
        Address: z.string().optional().describe('Override the street address.'),
        ZipCode: z.string().optional().describe('Override the postal code.'),
        City: z.string().optional().describe('Override the city.'),
        Country: z.string().optional().describe('Override the ISO country code.'),
        EmailAddress: z
          .string()
          .optional()
          .describe('Override the recipient email — this is where sending delivers to.'),

        InvoiceCode: z.string().optional().describe('Set an explicit invoice number. Omit to let WeFact assign it.'),
        CustomFields: z.record(z.unknown()).optional().describe('Custom fields, keyed by field code.'),
        AccountingCostCentre: z
          .string()
          .optional()
          .describe('Cost centre code — only if accounting integration is on.'),
        AccountingProject: z.string().optional().describe('Project code — only if accounting integration is on.'),

        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ action, identifier, code, confirm, administration, ...fields }) =>
      guard(async () => {
        if (action === 'add') {
          if (fields.Debtor === undefined && !fields.DebtorCode) {
            throw new Error('Creating an invoice requires `Debtor` (id) or `DebtorCode`.');
          }
          if (!fields.InvoiceLines || fields.InvoiceLines.length === 0) {
            throw new Error('Creating an invoice requires at least one entry in `InvoiceLines`.');
          }
        }

        const selector = action === 'edit' ? buildSelector('InvoiceCode', { identifier, code }, 'invoice') : {};
        const body = {
          ...selector,
          ...compact(fields),
          // WeFact would otherwise default this to "yes" and move stock silently.
          UseProductInventory: fields.UseProductInventory ?? 'no',
        } as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: action === 'add' ? 'created' : 'updated',
          plannedKey: 'plannedInvoice',
          resultKey: 'invoice',
          body,
          extra: { action, inventoryAffected: body['UseProductInventory'] === 'yes' },
          execute: async () => {
            const envelope = await client.request({
              administration,
              ...(action === 'add' ? EP.invoiceAdd : EP.invoiceEdit),
              params: body,
            });
            return envelope['invoice'] ?? null;
          },
        });
      }),
  );

  server.registerTool(
    'manage_invoice_lines',
    {
      description:
        'Add, delete or reorder the lines of an existing invoice. ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default. ' +
        'Works on invoices in ANY status, including sent and paid ones — totals are recalculated, so deleting a ' +
        'line from a paid invoice changes what the customer owes. ' +
        'For "add" pass `lines` as full line objects; for "delete" and "sort" pass `lines` as objects carrying ' +
        'only `Identifier` (get them from get_invoice). For "sort", the array order becomes the new line order. ' +
        'There is no line-edit action in WeFact: to change a line, delete it and add a replacement. ' +
        'Calls controller `invoiceline` (actions `add` / `delete`) and controller `invoice` (action `sortlines`) — ' +
        'note the asymmetry, which is the opposite of what the WeFact docs state.',
      inputSchema: {
        action: z.enum(['add', 'delete', 'sort']).describe('Which line operation to perform.'),
        ...{
          identifier: z.number().int().positive().optional().describe('Invoice Identifier.'),
          code: z.string().optional().describe('InvoiceCode, e.g. "F2024-0001". Use this or `identifier`.'),
        },
        lines: z
          .array(z.union([documentLineSchema, lineReferenceSchema]))
          .min(1)
          .describe(
            'For "add": full line objects. For "delete" and "sort": objects with just `Identifier`. ' +
              'For "sort" the array order defines the new order.',
          ),
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ action, identifier, code, lines, administration, confirm }) =>
      guard(async () => {
        const selector = buildSelector('InvoiceCode', { identifier, code }, 'invoice');

        if (action !== 'add') {
          const missing = lines.findIndex((l) => (l as Record<string, unknown>)['Identifier'] === undefined);
          if (missing >= 0) {
            throw new Error(
              `Line ${missing + 1} has no \`Identifier\`. "${action}" needs the line ids from get_invoice.`,
            );
          }
        }

        const endpoint =
          action === 'add' ? EP.invoiceLineAdd : action === 'delete' ? EP.invoiceLineDelete : EP.invoiceSortLines;

        const body = { ...selector, InvoiceLines: lines } as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: action === 'add' ? 'created' : action === 'delete' ? 'deleted' : 'updated',
          plannedKey: 'plannedLines',
          resultKey: 'invoice',
          body,
          extra: { action, lineCount: lines.length },
          ...(action === 'delete'
            ? {
                consequence:
                  `${lines.length} line(s) will be permanently removed and the invoice totals recalculated — ` +
                  'this works even on sent and paid invoices.',
              }
            : {}),
          execute: async () => {
            const envelope = await client.request({ administration, ...endpoint, params: body });
            return envelope['invoice'] ?? envelope['success'] ?? null;
          },
        });
      }),
  );

  server.registerTool(
    'register_payment',
    {
      description:
        'Record a payment against a sales invoice or a purchase invoice. ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default. ' +
        '`action: "partial"` books an amount and needs `amountPaid` — when that clears the balance exactly, ' +
        'WeFact flips the document to paid on its own. `action: "paid"` marks the whole document paid. ' +
        '`action: "unpaid"` reverses that back to sent (sales invoices only). ' +
        'None of these work on drafts: a draft has no balance to settle. ' +
        'Set `type: "creditinvoice"` for a supplier invoice; note it has no "unpaid" action. ' +
        'Calls controller `invoice` or `creditinvoice`, actions `partpayment` / `markaspaid` / `markasunpaid`.',
      inputSchema: {
        action: z.enum(['partial', 'paid', 'unpaid']).describe('Kind of payment registration.'),
        type: z
          .enum(['invoice', 'creditinvoice'])
          .optional()
          .describe('"invoice" (sales, default) or "creditinvoice" (purchase).'),
        identifier: z.number().int().positive().optional().describe('Document Identifier.'),
        code: z.string().optional().describe('InvoiceCode or CreditInvoiceCode. Use this or `identifier`.'),
        amountPaid: z.number().optional().describe('Amount received. Required for action "partial".'),
        payDate: dateArg.optional().describe('Payment date (YYYY-MM-DD). Defaults to today for "paid".'),
        paymentMethod: z.enum(PAYMENT_METHODS).optional().describe('How it was paid. Default "wire".'),
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ action, type, identifier, code, amountPaid, payDate, paymentMethod, administration, confirm }) =>
      guard(async () => {
        const kind = type ?? 'invoice';
        if (action === 'partial' && amountPaid === undefined) {
          throw new Error('`amountPaid` is required when action is "partial".');
        }
        if (action === 'unpaid' && kind === 'creditinvoice') {
          throw new Error('WeFact has no "unpaid" action for purchase invoices — only sales invoices can be reversed.');
        }

        const codeField = kind === 'invoice' ? 'InvoiceCode' : 'CreditInvoiceCode';
        const selector = buildSelector(codeField, { identifier, code }, kind);

        const endpoint =
          kind === 'invoice'
            ? action === 'partial'
              ? EP.invoicePartPayment
              : action === 'paid'
                ? EP.invoiceMarkAsPaid
                : EP.invoiceMarkAsUnpaid
            : action === 'partial'
              ? EP.creditInvoicePartPayment
              : EP.creditInvoiceMarkAsPaid;

        const body = compact({
          ...selector,
          AmountPaid: action === 'partial' ? amountPaid : undefined,
          PayDate: payDate,
          PaymentMethod: paymentMethod,
        }) as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: 'written',
          plannedKey: 'plannedPayment',
          resultKey: 'result',
          body,
          extra: { action, type: kind },
          consequence:
            action === 'unpaid'
              ? 'The invoice will be marked unpaid again and returned to "sent" status.'
              : `A payment will be recorded against this ${kind === 'invoice' ? 'sales' : 'purchase'} invoice.`,
          execute: async () => {
            const envelope = await client.request({ administration, ...endpoint, params: body });
            return envelope['invoice'] ?? envelope['creditinvoice'] ?? envelope['success'] ?? null;
          },
        });
      }),
  );

  server.registerTool(
    'credit_invoice',
    {
      description:
        'Credit a sales invoice — create a mirror-image credit invoice that cancels it out. ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default. ' +
        'This is the ONLY way to reverse a finalised invoice; delete_record works on drafts only. ' +
        'IRREVERSIBLE: it creates a new numbered document with negated amounts, consumes an invoice number and ' +
        'marks the original as credited. There is no API undo. ' +
        'Returns the new credit invoice (Status 8), not the original. Calls controller `invoice`, action `credit`.',
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
          statusKey: 'created',
          plannedKey: 'plannedCredit',
          resultKey: 'creditInvoice',
          body,
          consequence:
            'A new numbered credit invoice will be created cancelling out the original. This consumes an invoice ' +
            'number and cannot be undone through the API.',
          execute: async () => {
            const envelope = await client.request({ administration, ...EP.invoiceCredit, params: body });
            return { invoice: envelope['invoice'] ?? null, messages: envelope['success'] ?? [] };
          },
        });
      }),
  );

  server.registerTool(
    'set_invoice_state',
    {
      description:
        'Block or unblock a draft invoice, or pause and reactivate the automatic payment/reminder process on a ' +
        'sent invoice. ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default. ' +
        '"block" applies to DRAFTS only: it stops further subscription lines being appended and prevents sending. ' +
        '"pause" applies to SENT or PARTLY PAID invoices only: it suspends reminders and dunning, optionally ' +
        'until `pausedUntil`, and can hide the online payment screen. Both are reflected in the invoice SubStatus. ' +
        'Calls controller `invoice`, actions `block` / `unblock` / `paymentprocesspause` / `paymentprocessreactivate`.',
      inputSchema: {
        action: z.enum(['block', 'unblock', 'pause', 'reactivate']).describe('Which state change to apply.'),
        identifier: z.number().int().positive().optional().describe('Invoice Identifier.'),
        code: z.string().optional().describe('InvoiceCode, e.g. "F2024-0001". Use this or `identifier`.'),
        pausedUntil: dateArg.optional().describe('End date of the pause (YYYY-MM-DD). Only for action "pause".'),
        pausedReason: z.string().optional().describe('Why the payment process is paused. Only for action "pause".'),
        disableOnlinePayment: z
          .enum(['yes', 'no'])
          .optional()
          .describe('Also hide the online payment screen while paused. Default "no". Only for action "pause".'),
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ action, identifier, code, pausedUntil, pausedReason, disableOnlinePayment, administration, confirm }) =>
      guard(async () => {
        const selector = buildSelector('InvoiceCode', { identifier, code }, 'invoice');

        const endpoint =
          action === 'block'
            ? EP.invoiceBlock
            : action === 'unblock'
              ? EP.invoiceUnblock
              : action === 'pause'
                ? EP.invoicePausePayment
                : EP.invoiceReactivatePayment;

        const body = compact({
          ...selector,
          ...(action === 'pause'
            ? {
                PaymentPausedEndDate: pausedUntil,
                PaymentPausedReason: pausedReason,
                DisableOnlinePayment: disableOnlinePayment,
              }
            : {}),
        }) as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: 'updated',
          plannedKey: 'plannedStateChange',
          resultKey: 'result',
          body,
          extra: { action },
          execute: async () => {
            const envelope = await client.request({ administration, ...endpoint, params: body });
            return envelope['invoice'] ?? envelope['success'] ?? null;
          },
        });
      }),
  );
}
