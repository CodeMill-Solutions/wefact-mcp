import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP, type Endpoint } from '../wefact-endpoints.js';
import { guard } from './result.js';
import { administrationArg, confirmArg } from './schemas.js';
import { buildSelector, compact, gatedWrite } from './write-helpers.js';

/**
 * Permanent deletion, deliberately centralised.
 *
 * Scattering six `delete_*` tools across the domain modules would make deletion
 * feel like an ordinary edit and duplicate the "drafts only" caveat six times.
 * One tool means one loud description, one confirmation gate, and one place a
 * reviewer has to look.
 *
 * Not every entity can be deleted: debtors, subscriptions, tasks and
 * interactions have no delete action in WeFact at all (verified).
 *
 * Endpoints:
 *   delete_record → controller `creditor` / `product` / `invoice` /
 *                   `creditinvoice` / `pricequote` / `transaction`, action `delete`
 */

const DELETABLE: Record<string, { endpoint: Endpoint; codeField: string | null; label: string; note?: string }> = {
  creditor: { endpoint: EP.creditorDelete, codeField: 'CreditorCode', label: 'supplier' },
  product: { endpoint: EP.productDelete, codeField: 'ProductCode', label: 'product' },
  invoice: {
    endpoint: EP.invoiceDelete,
    codeField: 'InvoiceCode',
    label: 'invoice',
    note: 'Drafts only — a finalised invoice must be reversed with credit_invoice instead.',
  },
  creditinvoice: { endpoint: EP.creditInvoiceDelete, codeField: 'CreditInvoiceCode', label: 'purchase invoice' },
  pricequote: { endpoint: EP.priceQuoteDelete, codeField: 'PriceQuoteCode', label: 'price quote' },
  transaction: { endpoint: EP.transactionDelete, codeField: null, label: 'bank transaction' },
};

export function registerRecordWriteTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'delete_record',
    {
      description:
        'PERMANENTLY DELETE a record. There is no undo and no recycle bin. ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default: it only ' +
        'deletes when `confirm: true` is passed. ' +
        'Deletable types: "creditor", "product", "invoice", "creditinvoice", "pricequote", "transaction". ' +
        'IMPORTANT: `type: "invoice"` works on DRAFTS ONLY — a finalised invoice cannot be deleted for legal ' +
        'numbering reasons and must be reversed with credit_invoice instead. ' +
        'Customers, subscriptions, tasks and interactions have NO delete action in WeFact: a subscription is ' +
        'ended with terminate_subscription, a task by setting its status to completed, and a customer cannot be ' +
        'removed through the API at all. ' +
        'Set `withPurchaseInvoices: true` on a creditor to delete its purchase invoices along with it. ' +
        'Calls the matching controller with action `delete`.',
      inputSchema: {
        type: z
          .enum(['creditor', 'product', 'invoice', 'creditinvoice', 'pricequote', 'transaction'])
          .describe('What kind of record to delete.'),
        identifier: z.number().int().positive().optional().describe('Record Identifier.'),
        code: z
          .string()
          .optional()
          .describe('Record code (CreditorCode, ProductCode, InvoiceCode, …). Not available for transactions.'),
        withPurchaseInvoices: z
          .boolean()
          .optional()
          .describe('Only for type "creditor": also delete that supplier\'s purchase invoices.'),
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ type, identifier, code, withPurchaseInvoices, administration, confirm }) =>
      guard(async () => {
        const spec = DELETABLE[type];
        if (!spec) throw new Error(`"${type}" cannot be deleted through the WeFact API.`);

        if (!spec.codeField && code) {
          throw new Error(`\`code\` is not supported for ${spec.label}s; use \`identifier\`.`);
        }

        const selector = spec.codeField
          ? buildSelector(spec.codeField, { identifier, code }, spec.label)
          : (() => {
              if (identifier === undefined) throw new Error(`\`identifier\` is required to delete a ${spec.label}.`);
              return { Identifier: identifier };
            })();

        const body = compact({
          ...selector,
          ...(type === 'creditor' && withPurchaseInvoices !== undefined
            ? { withcreditinvoice: withPurchaseInvoices ? 'yes' : 'no' }
            : {}),
        }) as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: 'deleted',
          plannedKey: 'plannedDeletion',
          resultKey: 'result',
          body,
          extra: { type },
          consequence:
            `The ${spec.label} will be permanently deleted. This cannot be undone.` +
            (spec.note ? ` ${spec.note}` : '') +
            (type === 'creditor' && withPurchaseInvoices ? ' Its purchase invoices will be deleted too.' : ''),
          execute: async () => {
            const envelope = await client.request({ administration, ...spec.endpoint, params: body });
            return { messages: envelope['success'] ?? [] };
          },
        });
      }),
  );
}
