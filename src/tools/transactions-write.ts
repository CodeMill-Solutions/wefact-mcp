import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { guard } from './result.js';
import { administrationArg, confirmArg, dateArg } from './schemas.js';
import { BANK_TRANSACTION_TYPES } from './enums.js';
import { compact, gatedWrite, sendEnabled } from './write-helpers.js';

/**
 * Bank transactions (banktransacties) — write side.
 *
 * WeFact has no `transaction/edit` action (verified), so transactions are
 * create-only; a wrong one must be deleted via `delete_record` and re-created.
 *
 * Endpoints:
 *   create_transaction → controller `transaction`, action `add`
 *   match_transaction  → controller `transaction`, action `match`
 *   ignore_transaction → controller `transaction`, action `ignore`
 */
export function registerTransactionWriteTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'create_transaction',
    {
      description:
        'Import a bank transaction into WeFact so it can be reconciled against invoices. ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default. ' +
        'Requires `bankAccount` (YOUR IBAN), `date`, `type`, `amount` and `currency`. The counterparty fields ' +
        'describe the other side of the payment. Leave `bankReference` empty and WeFact generates a unique one. ' +
        'The transaction arrives with status "unmatched"; use match_transaction to link it to a document. ' +
        'NOTE: WeFact has no edit action for transactions — to correct one you must delete it and create it again. ' +
        'Calls controller `transaction`, action `add`.',
      inputSchema: {
        bankAccount: z.string().describe('YOUR bank account (IBAN) that the transaction belongs to.'),
        date: dateArg.describe('Transaction date (YYYY-MM-DD).'),
        type: z
          .enum(BANK_TRANSACTION_TYPES)
          .describe('"deposit" money in, "withdrawal" money out, "batch" a batch, "reversal" a chargeback.'),
        amount: z
          .number()
          .describe(
            'Transaction amount. Must be POSITIVE for "deposit"/"batch" and NEGATIVE for "withdrawal"/"reversal" — ' +
              'the sign carries the direction, so money out is e.g. -9.99.',
          ),
        currency: z.string().describe('Currency code, e.g. "EUR".'),
        shortDescription: z.string().optional().describe('Short description / payment reference.'),
        extendedDescription: z.string().optional().describe('Full description from the bank statement.'),
        accountName: z.string().optional().describe('Counterparty account holder name.'),
        accountNumber: z.string().optional().describe('Counterparty IBAN.'),
        accountBIC: z.string().optional().describe('Counterparty BIC.'),
        bankReference: z.string().optional().describe('Bank reference. Omit to let WeFact generate a unique one.'),
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ administration, confirm, ...fields }) =>
      guard(async () => {
        // WeFact encodes direction in the sign and rejects a mismatch. Catching
        // it here costs nothing and beats a round-trip plus a Dutch error.
        const outgoing = fields.type === 'withdrawal' || fields.type === 'reversal';
        if (outgoing && fields.amount > 0) {
          throw new Error(
            `Amount must be negative when type is "${fields.type}" — WeFact carries the direction in the sign. ` +
              `Pass ${-fields.amount} instead of ${fields.amount}.`,
          );
        }
        if (!outgoing && fields.amount < 0) {
          throw new Error(
            `Amount must be positive when type is "${fields.type}". Use type "withdrawal" for money going out.`,
          );
        }

        const body = compact({
          BankAccount: fields.bankAccount,
          Date: fields.date,
          Type: fields.type,
          Amount: fields.amount,
          Currency: fields.currency,
          ShortDescription: fields.shortDescription,
          ExtendedDescription: fields.extendedDescription,
          AccountName: fields.accountName,
          AccountNumber: fields.accountNumber,
          AccountBIC: fields.accountBIC,
          BankReference: fields.bankReference,
        }) as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: 'created',
          plannedKey: 'plannedTransaction',
          resultKey: 'transaction',
          body,
          execute: async () => {
            const envelope = await client.request({ administration, ...EP.transactionAdd, params: body });
            return envelope['transaction'] ?? null;
          },
        });
      }),
  );

  server.registerTool(
    'match_transaction',
    {
      description:
        'Reconcile a bank transaction against one or more invoices, purchase invoices or direct-debit batches. ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default. ' +
        '`matches` is a list, so one payment can be split across several documents. Each entry needs ' +
        '`ReferenceId`, `ReferenceType` ("invoice", "creditinvoice" or "directdebit"), `MatchedAmount`, ' +
        '`Currency` and `PaymentType` ("received", "paid" or "directdebit"). ' +
        'Setting `MarkAsPaid: "yes"` on an entry ALSO marks that document paid — a real financial state change. ' +
        'A `Reversal` block handles chargebacks and can pull invoices out of direct-debit batches or remove a ' +
        'customer mandate; its `NotifyClient: "yes"` EMAILS THE CUSTOMER and therefore additionally requires ' +
        'WEFACT_ALLOW_SEND. Calls controller `transaction`, action `match`.',
      inputSchema: {
        identifier: z.number().int().positive().describe('Transaction Identifier to reconcile.'),
        matches: z
          .array(
            z
              .object({
                ReferenceId: z.number().int().positive().describe('Identifier of the document being matched.'),
                ReferenceType: z
                  .enum(['invoice', 'creditinvoice', 'directdebit'])
                  .describe('What kind of document this entry matches.'),
                MatchedAmount: z.number().describe('Amount attributed to this document.'),
                Currency: z.string().describe('Currency code, e.g. "EUR".'),
                PaymentType: z
                  .enum(['received', 'paid', 'directdebit'])
                  .describe('Direction of the payment for this entry.'),
                MarkAsPaid: z.enum(['yes', 'no']).optional().describe('Also mark the matched document as paid.'),
                DoublePayment: z.enum(['yes', 'no']).optional().describe('Flag this as a double payment.'),
                Reversal: z
                  .object({
                    Reason: z.string().optional().describe('Why the payment was reversed.'),
                    InvoiceAction: z
                      .enum([
                        'move_to_next_batch',
                        'remove_direct_debit_from_invoice',
                        'remove_direct_debit_from_debtor',
                      ])
                      .optional()
                      .describe('What to do with the invoice or mandate after the reversal.'),
                    BatchDate: z.string().optional().describe('Direct-debit batch date.'),
                    NotifyClient: z
                      .enum(['yes', 'no'])
                      .optional()
                      .describe('EMAILS THE CUSTOMER about the reversal. Requires WEFACT_ALLOW_SEND.'),
                  })
                  .optional()
                  .describe('Chargeback / storno handling.'),
              })
              .passthrough(),
          )
          .min(1)
          .describe('One entry per document this transaction should be matched against.'),
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ identifier, matches, administration, confirm }) =>
      guard(async () => {
        const notifies = matches.some((m) => m.Reversal?.NotifyClient === 'yes');
        if (notifies && !sendEnabled()) {
          throw new Error(
            'A match entry sets Reversal.NotifyClient="yes", which emails the customer. ' +
              'Set WEFACT_ALLOW_SEND=true to permit that, or remove NotifyClient.',
          );
        }

        const marksPaid = matches.filter((m) => m.MarkAsPaid === 'yes').length;
        const body = { Identifier: identifier, Matches: matches } as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: 'written',
          plannedKey: 'plannedMatch',
          resultKey: 'transaction',
          body,
          extra: { matchCount: matches.length, documentsMarkedPaid: marksPaid },
          consequence:
            `The transaction will be matched to ${matches.length} document(s)` +
            (marksPaid > 0 ? `, and ${marksPaid} of them marked as paid` : '') +
            (notifies ? ', and the customer will be emailed about a reversal' : '') +
            '.',
          execute: async () => {
            const envelope = await client.request({ administration, ...EP.transactionMatch, params: body });
            return envelope['transaction'] ?? null;
          },
        });
      }),
  );

  server.registerTool(
    'ignore_transaction',
    {
      description:
        'Mark a bank transaction as ignored, so it stops appearing among the unmatched transactions awaiting ' +
        'reconciliation. Use this for payments that will never be matched to a WeFact document — private ' +
        'withdrawals, internal transfers, bank charges. ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default. ' +
        'WeFact has no documented un-ignore action, so treat this as one-way. ' +
        'Calls controller `transaction`, action `ignore`.',
      inputSchema: {
        identifier: z.number().int().positive().describe('Transaction Identifier.'),
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ identifier, administration, confirm }) =>
      guard(async () => {
        const body = { Identifier: identifier } as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: 'updated',
          plannedKey: 'plannedIgnore',
          resultKey: 'transaction',
          body,
          consequence: 'The transaction will be set to "ignored". WeFact has no documented way to undo this.',
          execute: async () => {
            const envelope = await client.request({ administration, ...EP.transactionIgnore, params: body });
            return envelope['transaction'] ?? null;
          },
        });
      }),
  );
}
