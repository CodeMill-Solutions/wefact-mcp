import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { guard } from './result.js';
import { administrationArg, confirmArg, creditInvoiceLineSchema, dateArg, lineReferenceSchema } from './schemas.js';
import { PAYMENT_METHODS } from './enums.js';
import { buildSelector, compact, gatedWrite } from './write-helpers.js';

/**
 * Purchase invoices (inkoopfacturen) — write side.
 *
 * Payments are registered through `register_payment` with type "creditinvoice";
 * deletion goes through `delete_record`.
 *
 * Endpoints:
 *   save_credit_invoice         → controller `creditinvoice`, actions `add` / `edit`
 *   manage_credit_invoice_lines → controller `creditinvoiceline`, actions `add` / `delete`
 */
export function registerCreditInvoiceWriteTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'save_credit_invoice',
    {
      description:
        'Create or update a purchase invoice (inkoopfactuur — a bill received from a supplier). ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default: it only writes ' +
        'when `confirm: true` is passed; otherwise it returns the exact body it would send. ' +
        '`action: "add"` requires `InvoiceCode` (the SUPPLIER\'s invoice number), a supplier (`Creditor` id or ' +
        '`CreditorCode`) and at least one entry in `InvoiceLines`. `action: "edit"` requires `identifier` or ' +
        '`code` (your own CreditInvoiceCode). ' +
        'Purchase lines differ from sales lines: there is NO quantity field, so put the line total in `PriceExcl`, ' +
        'use purchase VAT codes such as "I21", and set `CostCategory` to a numeric id from ' +
        'get_settings(section: "cost_categories"). ' +
        "`AmountIncl` is an optional override for correcting the supplier's VAT rounding. " +
        'Calls controller `creditinvoice`, actions `add` / `edit`.',
      inputSchema: {
        action: z.enum(['add', 'edit']).describe('"add" to book a new supplier invoice, "edit" to update one.'),
        identifier: z.number().int().positive().optional().describe('Purchase invoice Identifier. For "edit".'),
        code: z.string().optional().describe('Your own CreditInvoiceCode, e.g. "CF0002". Alternative key for "edit".'),

        InvoiceCode: z
          .string()
          .optional()
          .describe('The SUPPLIER\'s invoice number, e.g. "INV123456". Required for "add".'),
        Creditor: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Supplier Identifier. Required for "add" unless CreditorCode.'),
        CreditorCode: z
          .string()
          .optional()
          .describe('Supplier number, e.g. "CR10000". Required for "add" unless Creditor.'),

        InvoiceLines: z
          .array(creditInvoiceLineSchema)
          .optional()
          .describe('Purchase invoice lines. Required for "add" (at least one). Note: no quantity field.'),

        Date: dateArg.optional().describe('Invoice date (YYYY-MM-DD). Defaults to today.'),
        Term: z.number().int().optional().describe('Payment term in days. Defaults to the supplier setting.'),
        AmountIncl: z.number().optional().describe('Override the VAT-inclusive total, to match the supplier exactly.'),
        AmountPaid: z.number().optional().describe('Amount already paid. For real payments use register_payment.'),
        Status: z.number().int().optional().describe('1 unpaid (default), 2 partly paid, 3 paid, 8 credit.'),
        PaymentMethod: z.enum(PAYMENT_METHODS).optional().describe('How it was paid. Default "wire".'),
        PayDate: dateArg.optional().describe('Payment date (YYYY-MM-DD).'),
        Authorisation: z
          .enum(['yes', 'no'])
          .optional()
          .describe('Pay by direct debit. Defaults to the supplier setting.'),
        Currency: z.string().optional().describe('Currency code, e.g. "EUR".'),
        Comment: z.string().optional().describe('Internal note.'),

        CreditInvoiceCode: z
          .string()
          .optional()
          .describe('Set your own internal number explicitly. Omit to let WeFact assign the next one.'),
        ProductInventory: z
          .record(z.unknown())
          .optional()
          .describe('Stock module container, e.g. { "ProductId": 1, "Number": 10 } to add received goods to stock.'),
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
          if (!fields.InvoiceCode) {
            throw new Error("Booking a purchase invoice requires `InvoiceCode` — the supplier's own invoice number.");
          }
          if (fields.Creditor === undefined && !fields.CreditorCode) {
            throw new Error('Booking a purchase invoice requires `Creditor` (id) or `CreditorCode`.');
          }
          if (!fields.InvoiceLines || fields.InvoiceLines.length === 0) {
            throw new Error('Booking a purchase invoice requires at least one entry in `InvoiceLines`.');
          }
        }

        const selector =
          action === 'edit' ? buildSelector('CreditInvoiceCode', { identifier, code }, 'purchase invoice') : {};
        const body = { ...selector, ...compact(fields) } as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: action === 'add' ? 'created' : 'updated',
          plannedKey: 'plannedCreditInvoice',
          resultKey: 'creditInvoice',
          body,
          extra: { action },
          execute: async () => {
            const envelope = await client.request({
              administration,
              ...(action === 'add' ? EP.creditInvoiceAdd : EP.creditInvoiceEdit),
              params: body,
            });
            return envelope['creditinvoice'] ?? null;
          },
        });
      }),
  );

  server.registerTool(
    'manage_credit_invoice_lines',
    {
      description:
        'Add or delete lines on an existing purchase invoice. ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default. ' +
        'For "add" pass `lines` as full line objects (Description, PriceExcl, TaxCode, CostCategory — no quantity ' +
        'field exists); for "delete" pass objects carrying only `Identifier`, from get_credit_invoice. ' +
        'SAFETY: WeFact defaults `RecalculateInclTotalAmount` to "no", which leaves the VAT-inclusive total stale ' +
        'and silently inconsistent with the lines. This tool defaults it to "yes" — pass "no" only when you are ' +
        "deliberately preserving the supplier's stated total. " +
        'There is no sort action for purchase invoice lines. Calls controller `creditinvoiceline`, actions ' +
        '`add` / `delete`.',
      inputSchema: {
        action: z.enum(['add', 'delete']).describe('Which line operation to perform.'),
        identifier: z.number().int().positive().optional().describe('Purchase invoice Identifier.'),
        code: z.string().optional().describe('CreditInvoiceCode, e.g. "CF0002". Use this or `identifier`.'),
        lines: z
          .array(z.union([creditInvoiceLineSchema, lineReferenceSchema]))
          .min(1)
          .describe('For "add": full line objects. For "delete": objects with just `Identifier`.'),
        recalculateTotal: z
          .enum(['yes', 'no'])
          .optional()
          .describe('Recalculate the VAT-inclusive total. Defaults to "yes" here; WeFact itself defaults to "no".'),
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ action, identifier, code, lines, recalculateTotal, administration, confirm }) =>
      guard(async () => {
        const selector = buildSelector('CreditInvoiceCode', { identifier, code }, 'purchase invoice');

        if (action === 'delete') {
          const missing = lines.findIndex((l) => (l as Record<string, unknown>)['Identifier'] === undefined);
          if (missing >= 0) {
            throw new Error(
              `Line ${missing + 1} has no \`Identifier\`. Deleting needs the line ids from get_credit_invoice.`,
            );
          }
        }

        const body = {
          ...selector,
          InvoiceLines: lines,
          RecalculateInclTotalAmount: recalculateTotal ?? 'yes',
        } as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: action === 'add' ? 'created' : 'deleted',
          plannedKey: 'plannedLines',
          resultKey: 'creditInvoice',
          body,
          extra: { action, lineCount: lines.length },
          ...(action === 'delete'
            ? { consequence: `${lines.length} line(s) will be permanently removed from the purchase invoice.` }
            : {}),
          execute: async () => {
            const envelope = await client.request({
              administration,
              ...(action === 'add' ? EP.creditInvoiceLineAdd : EP.creditInvoiceLineDelete),
              params: body,
            });
            return envelope['creditinvoice'] ?? envelope['success'] ?? null;
          },
        });
      }),
  );
}
