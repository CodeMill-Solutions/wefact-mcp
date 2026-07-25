import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { guard } from './result.js';
import { administrationArg, confirmArg } from './schemas.js';
import { SEX_VALUES } from './enums.js';
import { buildSelector, compact, gatedWrite } from './write-helpers.js';

/**
 * Creditors (leveranciers — suppliers) — write side.
 *
 * Deleting a creditor lives in `delete_record`, alongside the other destructive
 * operations, rather than here.
 *
 * Endpoints:
 *   save_creditor → controller `creditor`, actions `add` / `edit`
 */
export function registerCreditorWriteTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'save_creditor',
    {
      description:
        'Create or update a creditor (leverancier — supplier). ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default: it only writes ' +
        'when `confirm: true` is passed; otherwise it returns the exact body it would send. ' +
        '`action: "add"` requires at least `CompanyName` or `SurName`, and leaves `CreditorCode` off to let WeFact ' +
        'assign the next supplier number. `action: "edit"` requires `identifier` or `code` and changes only the ' +
        'fields you supply. To remove a supplier use delete_record with type "creditor". ' +
        'Since API 2.4.3 suppliers use booking rules, so CustomTaxCode and CostCategory are not settable here. ' +
        'Calls controller `creditor`, actions `add` / `edit`.',
      inputSchema: {
        action: z.enum(['add', 'edit']).describe('"add" to create a new supplier, "edit" to update an existing one.'),
        identifier: z.number().int().positive().optional().describe('Creditor Identifier. Required for "edit".'),
        code: z.string().optional().describe('CreditorCode, e.g. "CR10000". Alternative lookup key for "edit".'),

        CompanyName: z.string().optional().describe('Company name. Required for "add" unless SurName is given.'),
        SurName: z.string().optional().describe('Last name. Required for "add" unless CompanyName is given.'),
        Initials: z.string().optional().describe('Initials.'),
        Sex: z.enum(SEX_VALUES).optional().describe('Salutation: m male, f female, d diverse, fam family, u unknown.'),
        CompanyNumber: z.string().optional().describe('Chamber of Commerce (KvK) number.'),
        TaxNumber: z.string().optional().describe('VAT number.'),
        MyCustomerCode: z.string().optional().describe('Your own customer number at this supplier.'),

        Address: z.string().optional().describe('Street address.'),
        ZipCode: z.string().optional().describe('Postal code.'),
        City: z.string().optional().describe('City.'),
        Country: z.string().optional().describe('Country as an ISO 3166-1 alpha-2 code, e.g. "NL".'),
        EmailAddress: z.string().optional().describe('Email address.'),
        PhoneNumber: z.string().optional().describe('Phone number.'),
        MobileNumber: z.string().optional().describe('Mobile number.'),
        FaxNumber: z.string().optional().describe('Fax number.'),
        Comment: z.string().optional().describe('Internal note.'),

        InvoiceTerm: z.number().int().optional().describe('Payment term in days. WeFact defaults to 14.'),
        Authorisation: z.enum(['yes', 'no']).optional().describe('Pay this supplier by direct debit. Default "no".'),
        AccountNumber: z.string().optional().describe('Bank account (IBAN).'),
        AccountName: z.string().optional().describe('Account holder name.'),
        AccountBank: z.string().optional().describe('Bank name.'),
        AccountCity: z.string().optional().describe('Bank city.'),
        AccountBIC: z.string().optional().describe('BIC / SWIFT code.'),

        CreditorCode: z
          .string()
          .optional()
          .describe('Set an explicit supplier number on "add". Omit to let WeFact assign the next one.'),
        ProductInventory: z
          .record(z.unknown())
          .optional()
          .describe('Inventory module container, e.g. { "ProductIds": [1, 2] } to link stocked products.'),

        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ action, identifier, code, confirm, administration, ...fields }) =>
      guard(async () => {
        if (action === 'add' && !fields.CompanyName && !fields.SurName) {
          throw new Error('Creating a supplier requires at least `CompanyName` or `SurName`.');
        }

        const selector = action === 'edit' ? buildSelector('CreditorCode', { identifier, code }, 'creditor') : {};
        const body = { ...selector, ...compact(fields) } as Record<string, unknown>;

        return gatedWrite({
          confirm,
          statusKey: action === 'add' ? 'created' : 'updated',
          plannedKey: 'plannedCreditor',
          resultKey: 'creditor',
          body,
          extra: { action },
          execute: async () => {
            const envelope = await client.request({
              administration,
              ...(action === 'add' ? EP.creditorAdd : EP.creditorEdit),
              params: body,
            });
            return envelope['creditor'] ?? null;
          },
        });
      }),
  );
}
