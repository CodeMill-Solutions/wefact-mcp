import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { guard } from './result.js';
import { administrationArg, confirmArg, dateArg } from './schemas.js';
import { PERIODIC_VALUES } from './enums.js';
import { compact, gatedWrite } from './write-helpers.js';

/**
 * Subscriptions (abonnementen) — write side.
 *
 * Two sharp edges are worth knowing before touching this:
 *
 *   - Creating a subscription can IMMEDIATELY invoice it, depending on the
 *     StartDate/NextDate and the administration's "invoice in advance" setting.
 *     It is not a quiet bookkeeping operation.
 *   - Un-terminating (clearing TerminationDate) resets the invoiced counter to
 *     zero, which silently changes what any TerminateAfter count means.
 *
 * Endpoints:
 *   save_subscription      → controller `subscription`, actions `add` / `edit`
 *   terminate_subscription → controller `subscription`, action `terminate`
 */
export function registerSubscriptionWriteTools(server: McpServer, client: WeFactClient): void {
  const subscriptionFields = {
    Number: z.number().optional().describe('Quantity (default 1).'),
    NumberSuffix: z.string().optional().describe('Unit shown after the quantity, e.g. "uur".'),
    ProductCode: z.string().optional().describe('Product number. Auto-fills description, price, VAT and recurrence.'),
    Description: z.string().optional().describe('Description. Required if no ProductCode is given.'),
    PriceExcl: z.number().optional().describe('Unit price excluding VAT. Required if no ProductCode is given.'),
    TaxCode: z.string().optional().describe('VAT code, e.g. "V21". See get_settings.'),
    DiscountPercentage: z.number().min(0).max(100).optional().describe('Discount percentage (0–100).'),
    Periods: z.number().int().positive().optional().describe('Bill every N periods (default 1).'),
    Periodic: z
      .enum(PERIODIC_VALUES)
      .optional()
      .describe(
        'Period unit: d day, w week, m month, k quarter, h half year, j year, t two years. ' +
          'Required if no ProductCode is given. Periods × Periodic is the billing interval.',
      ),
    StartDate: dateArg.optional().describe('Start of the first billed period (YYYY-MM-DD).'),
    NextDate: dateArg
      .optional()
      .describe('Next invoicing date (YYYY-MM-DD). Only settable when "invoice in advance" is 0.'),
    TerminationDate: dateArg
      .optional()
      .describe('Date the subscription ends (YYYY-MM-DD). Mutually exclusive with TerminateAfter.'),
    TerminateAfter: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Stop after this many invoices; 0 means indefinitely. Counts invoices ALREADY generated, so it is not ' +
          '"N more times". Mutually exclusive with TerminationDate.',
      ),
    Comment: z.string().optional().describe('Internal note.'),
    DirectDebit: z
      .enum(['client', 'yes', 'no'])
      .optional()
      .describe('Collect by direct debit. "client" (default) follows the customer\'s own setting.'),
    AccountingCostCentre: z.string().optional().describe('Cost centre code — only if accounting integration is on.'),
    AccountingProject: z.string().optional().describe('Project code — only if accounting integration is on.'),
  };

  server.registerTool(
    'save_subscription',
    {
      description:
        'Create or update a subscription (abonnement — a recurring service WeFact invoices automatically). ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default: it only writes ' +
        'when `confirm: true` is passed; otherwise it returns the exact body it would send. ' +
        '`action: "add"` requires a customer (`Debtor` id or `DebtorCode`) plus either a `ProductCode` or the trio ' +
        '`Description` + `PriceExcl` + `Periodic`. `action: "edit"` requires `identifier`. ' +
        'The billing interval is Periods × Periodic — 3 × "m" is quarterly. Bound the run with EITHER ' +
        '`TerminationDate` (a date) OR `TerminateAfter` (a count), never both. ' +
        'CAUTION: creating a subscription can trigger an IMMEDIATE invoice, depending on StartDate/NextDate and ' +
        'the administration\'s "invoice in advance" setting. Set a future `StartDate` if you do not want that. ' +
        'Calls controller `subscription`, actions `add` / `edit`.',
      inputSchema: {
        action: z.enum(['add', 'edit']).describe('"add" to create a new subscription, "edit" to update one.'),
        identifier: z.number().int().positive().optional().describe('Subscription Identifier. Required for "edit".'),
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
        ...subscriptionFields,
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ action, identifier, Debtor, DebtorCode, confirm, administration, ...fields }) =>
      guard(async () => {
        if (action === 'add') {
          if (Debtor === undefined && !DebtorCode) {
            throw new Error('Creating a subscription requires `Debtor` (id) or `DebtorCode`.');
          }
          if (!fields.ProductCode && !(fields.Description && fields.PriceExcl !== undefined && fields.Periodic)) {
            throw new Error(
              'Creating a subscription requires `ProductCode`, or all of `Description`, `PriceExcl` and `Periodic`.',
            );
          }
        } else if (identifier === undefined) {
          throw new Error('`identifier` is required when action is "edit".');
        }

        if (fields.TerminationDate && fields.TerminateAfter !== undefined) {
          throw new Error(
            'Set either `TerminationDate` or `TerminateAfter`, not both — WeFact cannot honour two end conditions.',
          );
        }

        const body = compact({
          Identifier: identifier,
          Debtor,
          DebtorCode,
          Subscription: compact(fields),
          // WeFact's documentation is ambiguous about whether DirectDebit belongs
          // at the top level or inside Subscription; sending both is harmless and
          // works either way.
          DirectDebit: fields.DirectDebit,
        }) as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: action === 'add' ? 'created' : 'updated',
          plannedKey: 'plannedSubscription',
          resultKey: 'subscription',
          body,
          extra: { action },
          ...(action === 'add'
            ? {
                consequence:
                  'Depending on StartDate/NextDate and the "invoice in advance" setting, WeFact may invoice this ' +
                  'subscription immediately on creation.',
              }
            : {}),
          execute: async () => {
            const envelope = await client.request({
              administration,
              ...(action === 'add' ? EP.subscriptionAdd : EP.subscriptionEdit),
              params: body,
            });
            return { subscription: envelope['subscription'] ?? null, messages: envelope['success'] ?? [] };
          },
        });
      }),
  );

  server.registerTool(
    'terminate_subscription',
    {
      description:
        'Cancel a subscription, or undo a cancellation. ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default. ' +
        'This is the only way to remove a subscription: WeFact has no delete action for them. ' +
        'Pass `terminationDate` to cancel per a specific date, or `terminateAfter` to stop after a total number of ' +
        'invoices (0 means indefinitely). ' +
        'CAUTION on `undo: true`: clearing the termination date also RESETS the invoiced counter to zero, which ' +
        'silently changes the meaning of any TerminateAfter still set and can cause extra billing cycles. ' +
        'Calls controller `subscription`, action `terminate`.',
      inputSchema: {
        identifier: z.number().int().positive().describe('Subscription Identifier. The only accepted lookup key.'),
        terminationDate: dateArg.optional().describe('Cancel per this date (YYYY-MM-DD).'),
        terminateAfter: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Stop after this total number of invoices; 0 means indefinitely.'),
        undo: z
          .boolean()
          .optional()
          .describe('Clear the termination and reactivate. WARNING: this also resets the invoiced counter to 0.'),
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ identifier, terminationDate, terminateAfter, undo, administration, confirm }) =>
      guard(async () => {
        if (undo && (terminationDate || terminateAfter !== undefined)) {
          throw new Error('`undo` cannot be combined with `terminationDate` or `terminateAfter`.');
        }
        if (!undo && !terminationDate && terminateAfter === undefined) {
          throw new Error('Provide `terminationDate`, `terminateAfter`, or `undo: true`.');
        }

        const body = {
          Identifier: identifier,
          Subscription: undo
            ? { TerminationDate: '' }
            : compact({ TerminationDate: terminationDate, TerminateAfter: terminateAfter }),
        } as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: 'updated',
          plannedKey: 'plannedTermination',
          resultKey: 'subscription',
          body,
          consequence: undo
            ? 'The cancellation will be undone AND the invoiced counter reset to 0, which may cause extra billing cycles.'
            : 'The subscription will be cancelled. There is no delete action, so this is how a subscription ends.',
          execute: async () => {
            const envelope = await client.request({
              administration,
              ...EP.subscriptionTerminate,
              params: body,
            });
            return { subscription: envelope['subscription'] ?? null, messages: envelope['success'] ?? [] };
          },
        });
      }),
  );
}
