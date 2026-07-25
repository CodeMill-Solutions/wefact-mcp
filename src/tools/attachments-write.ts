import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { guard } from './result.js';
import { administrationArg, attachmentTypeArg, ATTACHMENT_PARENT_CODE_FIELD, confirmArg } from './schemas.js';
import { compact, gatedWrite } from './write-helpers.js';

/**
 * Attachments (bijlagen) — write side.
 *
 * Every parent type shares one `attachment` controller, discriminated by `Type`.
 * There is no `attachment/list`: to see what is attached to a record, read the
 * record with its `get_*` tool and look at its `Attachments` array.
 * Downloading is `download_document(type: "attachment")`.
 *
 * Endpoints:
 *   manage_attachments → controller `attachment`, actions `add` / `delete`
 */
export function registerAttachmentWriteTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'manage_attachments',
    {
      description:
        'Attach a file to a record, or remove one. ' +
        'WRITE TOOL — disabled unless the server has WEFACT_ALLOW_WRITES=true. Dry-run by default (the dry-run ' +
        'preview reports the file size rather than echoing the base64). ' +
        '`type` selects the parent: debtor, creditor, invoice, pricequote, creditinvoice, crm_task or ' +
        'crm_interaction — note the crm_ prefix on the last two. Identify the parent with `identifier`, or with ' +
        '`code` for the five types that have one (CRM records are id-only). ' +
        'For "add" pass `filename` and `base64` (raw base64, no data: URI prefix). WeFact returns no attachment id, ' +
        'so re-read the parent record to find it. For "delete" identify the file by `attachmentId` or `filename`. ' +
        'To download an attachment use download_document. Calls controller `attachment`, actions `add` / `delete`.',
      inputSchema: {
        action: z.enum(['add', 'delete']).describe('Attach a file or remove one.'),
        type: attachmentTypeArg,
        identifier: z.number().int().positive().optional().describe('Identifier of the parent record.'),
        code: z
          .string()
          .optional()
          .describe('Parent code (DebtorCode, InvoiceCode, …). Not available for crm_task / crm_interaction.'),
        filename: z.string().optional().describe('File name, e.g. "contract.pdf". Required for "add".'),
        base64: z
          .string()
          .optional()
          .describe('File contents, base64-encoded without a data: URI prefix. Required for "add".'),
        attachmentId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Attachment id. For "delete", or use `filename`.'),
        confirm: confirmArg,
        administration: administrationArg,
      },
    },
    async ({ action, type, identifier, code, filename, base64, attachmentId, administration, confirm }) =>
      guard(async () => {
        const codeField = ATTACHMENT_PARENT_CODE_FIELD[type];

        if (identifier === undefined && !(code && codeField)) {
          throw new Error(
            codeField
              ? `Provide \`identifier\` (the ${type} id) or \`code\` (${codeField}) to say which record this attaches to.`
              : `\`identifier\` is required for ${type} attachments — this type has no code lookup.`,
          );
        }
        if (code && !codeField) {
          throw new Error(`\`code\` is not supported for ${type}; use \`identifier\` instead.`);
        }
        if (action === 'add' && (!filename || !base64)) {
          throw new Error('Adding an attachment requires both `filename` and `base64`.');
        }
        if (action === 'delete' && attachmentId === undefined && !filename) {
          throw new Error('Deleting an attachment requires `attachmentId` or `filename`.');
        }

        const body = compact({
          Type: type,
          ReferenceIdentifier: identifier,
          ...(code && codeField ? { [codeField]: code } : {}),
          Identifier: action === 'delete' ? attachmentId : undefined,
          Filename: filename,
          Base64: action === 'add' ? base64 : undefined,
        }) as Record<string, unknown>;

        // Echoing a whole base64 payload back into the dry-run preview would be
        // useless noise, so summarise it instead.
        const preview = { ...body };
        if (typeof preview['Base64'] === 'string') {
          const bytes = Math.floor(((preview['Base64'] as string).length * 3) / 4);
          preview['Base64'] = `<${bytes} bytes of base64, omitted from preview>`;
        }

        return gatedWrite({
          confirm,
          statusKey: action === 'add' ? 'created' : 'deleted',
          plannedKey: 'plannedAttachment',
          resultKey: 'result',
          body: preview,
          extra: { action, type },
          ...(action === 'delete' ? { consequence: 'The attachment will be permanently deleted.' } : {}),
          execute: async () => {
            const envelope = await client.request({
              administration,
              ...(action === 'add' ? EP.attachmentAdd : EP.attachmentDelete),
              params: body,
            });
            return { messages: envelope['success'] ?? [] };
          },
        });
      }),
  );
}
