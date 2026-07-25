import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { guard } from './result.js';
import { administrationArg, confirmArg, dateArg } from './schemas.js';
import { SEX_VALUES } from './enums.js';
import { buildSelector, compact, gatedWrite } from './write-helpers.js';

/**
 * Debtors (klanten — customers) — write side.
 *
 * WeFact has no `debtor/delete` action (verified against the live API), so a
 * customer can be created and edited but never removed through the API.
 *
 * Endpoints:
 *   save_debtor            → controller `debtor`, actions `add` / `edit`
 *   manage_debtor_contacts → controller `extraclientcontact`, actions `add` / `edit` / `delete`
 */
export function registerDebtorWriteTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'save_debtor',
    {
      description:
        'Create or update a debtor (klant — customer). ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default: it only writes ' +
        'when `confirm: true` is passed; otherwise it returns the exact body it would send so you can review it. ' +
        '`action: "add"` requires at least `CompanyName` or `SurName`, and leaves `DebtorCode` off to let WeFact ' +
        'assign the next customer number. `action: "edit"` requires `identifier` or `code`, and changes only the ' +
        'fields you supply. ' +
        'NOTE: WeFact has no delete action for customers — a customer created here cannot be removed via the API. ' +
        'When Mollie direct debit is active the mandate and bank fields are ignored and `MandateCreationType` ' +
        'becomes required instead. Calls controller `debtor`, actions `add` / `edit`.',
      inputSchema: {
        action: z.enum(['add', 'edit']).describe('"add" to create a new customer, "edit" to update an existing one.'),
        identifier: z.number().int().positive().optional().describe('Debtor Identifier. Required for "edit".'),
        code: z.string().optional().describe('DebtorCode, e.g. "DB10000". Alternative lookup key for "edit".'),

        CompanyName: z.string().optional().describe('Company name. Required for "add" unless SurName is given.'),
        SurName: z.string().optional().describe('Last name. Required for "add" unless CompanyName is given.'),
        Initials: z.string().optional().describe('First name / initials.'),
        Sex: z.enum(SEX_VALUES).optional().describe('Salutation: m male, f female, d diverse, fam family, u unknown.'),
        CompanyNumber: z.string().optional().describe('Chamber of Commerce (KvK) number.'),
        TaxNumber: z.string().optional().describe('VAT number.'),

        Address: z.string().optional().describe('Street address.'),
        ZipCode: z.string().optional().describe('Postal code.'),
        City: z.string().optional().describe('City.'),
        Country: z.string().optional().describe('Country as an ISO 3166-1 alpha-2 code, e.g. "NL".'),
        EmailAddress: z.string().optional().describe('Primary email address — where invoices are sent.'),
        PhoneNumber: z.string().optional().describe('Phone number.'),
        MobileNumber: z.string().optional().describe('Mobile number.'),
        FaxNumber: z.string().optional().describe('Fax number.'),
        Comment: z.string().optional().describe('Internal note, not shown to the customer.'),

        InvoiceMethod: z
          .number()
          .int()
          .optional()
          .describe('How invoices are delivered: 0 email, 1 post, 3 email and post, 5 Peppol.'),
        InvoiceTerm: z.number().int().optional().describe('Payment term in days. -1 means "use the default".'),
        PeriodicInvoiceDays: z
          .number()
          .int()
          .optional()
          .describe('Days before a subscription is invoiced. -1 = default.'),
        PaymentMail: z.number().int().optional().describe('Payment-mail behaviour. -1 = default.'),
        LanguageCode: z
          .string()
          .optional()
          .describe('Corporate identity / template, e.g. "nl_nl". See whoami or get_settings. Empty = default.'),
        Currency: z.string().optional().describe('Currency code, e.g. "EUR". Only if enabled in the administration.'),
        CustomTaxCode: z.string().optional().describe('Deviating VAT code for this customer. Empty = not deviating.'),
        ReminderEmailAddress: z.string().optional().describe('Alternate address for reminders and dunning notices.'),
        Mailing: z.enum(['yes', 'no', 'unsubscribed']).optional().describe('Whether the customer accepts mailings.'),
        PeppolAddress: z.string().optional().describe('Peppol participant address, e.g. "0106:17237249".'),

        DirectDebitApplyTo: z
          .enum(['none', 'invoices', 'subscriptions', 'all'])
          .optional()
          .describe('What to collect by direct debit. Default "none".'),
        MandateCreationType: z
          .enum(['manual', 'automatic'])
          .optional()
          .describe(
            '"manual" supplies MandateID/MandateDate/AccountNumber yourself; "automatic" emails the customer a ' +
              'mandate request. Required when Mollie direct debit is active.',
          ),
        MandateID: z.string().optional().describe('Direct debit mandate reference.'),
        MandateDate: dateArg.optional().describe('Date the mandate was signed (YYYY-MM-DD).'),
        AccountNumber: z.string().optional().describe('Bank account (IBAN).'),
        AccountName: z.string().optional().describe('Account holder name.'),
        AccountBank: z.string().optional().describe('Bank name.'),
        AccountCity: z.string().optional().describe('Bank city.'),
        AccountBIC: z.string().optional().describe('BIC / SWIFT code.'),

        DebtorCode: z
          .string()
          .optional()
          .describe('Set an explicit customer number on "add". Omit to let WeFact assign the next one.'),
        Groups: z.array(z.number().int()).optional().describe('Customer group ids this customer belongs to.'),
        CustomFields: z.record(z.unknown()).optional().describe('Custom fields, keyed by field code.'),

        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ action, identifier, code, confirm, administration, ...fields }) =>
      guard(async () => {
        if (action === 'add' && !fields.CompanyName && !fields.SurName) {
          throw new Error('Creating a customer requires at least `CompanyName` or `SurName`.');
        }

        const selector = action === 'edit' ? buildSelector('DebtorCode', { identifier, code }, 'debtor') : {};
        const body = { ...selector, ...compact(fields) } as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: action === 'add' ? 'created' : 'updated',
          plannedKey: 'plannedDebtor',
          resultKey: 'debtor',
          body,
          extra: { action },
          execute: async () => {
            const envelope = await client.request({
              administration,
              ...(action === 'add' ? EP.debtorAdd : EP.debtorEdit),
              params: body,
            });
            return envelope['debtor'] ?? null;
          },
        });
      }),
  );

  server.registerTool(
    'manage_debtor_contacts',
    {
      description:
        'Add, edit or remove an extra contact person on a customer — the people you can address an individual ' +
        'invoice or quote to via ExtraClientContactId. ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default. ' +
        '`action: "add"` needs the parent customer (`clientId` or `debtorCode`) plus at least CompanyName, ' +
        "LastName or EmailAddress. `edit` and `delete` need the contact's own `identifier`, which you get from " +
        'get_debtor under ExtraClientContacts. ' +
        'Note this lives on its own `extraclientcontact` controller rather than under `debtor`. ' +
        'Calls controller `extraclientcontact`, actions `add` / `edit` / `delete`.',
      inputSchema: {
        action: z.enum(['add', 'edit', 'delete']).describe('Which operation to perform.'),
        identifier: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Contact Identifier. Required for "edit" and "delete". From get_debtor → ExtraClientContacts.'),
        clientId: z.number().int().positive().optional().describe('Parent debtor Identifier. For "add".'),
        debtorCode: z.string().optional().describe('Parent DebtorCode, e.g. "DB10000". Alternative for "add".'),

        CompanyName: z.string().optional().describe('Company name.'),
        FirstName: z.string().optional().describe('First name.'),
        LastName: z.string().optional().describe('Last name.'),
        Salutation: z.enum(SEX_VALUES).optional().describe('Salutation: m, f, d, fam or u. Default "m".'),
        Address: z.string().optional().describe('Street address.'),
        ZipCode: z.string().optional().describe('Postal code.'),
        City: z.string().optional().describe('City.'),
        Country: z.string().optional().describe('ISO 3166-1 alpha-2 country code.'),
        EmailAddress: z.string().optional().describe('Email address.'),
        PhoneNumber: z.string().optional().describe('Phone number.'),
        MobileNumber: z.string().optional().describe('Mobile number.'),

        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ action, identifier, clientId, debtorCode, confirm, administration, ...fields }) =>
      guard(async () => {
        if (action === 'add') {
          if (clientId === undefined && !debtorCode) {
            throw new Error(
              'Adding a contact requires `clientId` or `debtorCode` to say which customer it belongs to.',
            );
          }
          if (!fields.CompanyName && !fields.LastName && !fields.EmailAddress) {
            throw new Error('Adding a contact requires at least `CompanyName`, `LastName` or `EmailAddress`.');
          }
        } else if (identifier === undefined) {
          throw new Error(`\`identifier\` is required when action is "${action}". Find it via get_debtor.`);
        } else if (action === 'edit' && !fields.CompanyName && !fields.LastName && !fields.EmailAddress) {
          // WeFact re-validates the identifying trio on edit too, and its own
          // error ("U dient of een e-mailadres of achternaam of bedrijfsnaam op
          // te geven") does not make clear that it applies to partial updates.
          throw new Error(
            'Editing a contact requires you to resend at least one of `CompanyName`, `LastName` or ' +
              '`EmailAddress`, even when changing another field — WeFact re-validates them on every edit. ' +
              'Read the current values with get_debtor and include them.',
          );
        }

        const endpoint =
          action === 'add' ? EP.extraContactAdd : action === 'edit' ? EP.extraContactEdit : EP.extraContactDelete;

        const body = compact({
          // WeFact rejects a stray Identifier on `add`.
          Identifier: action === 'add' ? undefined : identifier,
          ...(action === 'add' ? { ClientId: clientId, DebtorCode: debtorCode } : {}),
          ...(action === 'delete' ? {} : fields),
        }) as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: action === 'add' ? 'created' : action === 'edit' ? 'updated' : 'deleted',
          plannedKey: 'plannedContact',
          resultKey: 'contact',
          body,
          extra: { action },
          ...(action === 'delete' ? { consequence: 'The contact person will be permanently removed.' } : {}),
          execute: async () => {
            const envelope = await client.request({ administration, ...endpoint, params: body });
            return envelope['extraclientcontact'] ?? envelope['success'] ?? null;
          },
        });
      }),
  );
}
