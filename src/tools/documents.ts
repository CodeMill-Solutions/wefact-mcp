import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { ok, guard } from './result.js';
import { administrationArg, attachmentTypeArg, ATTACHMENT_PARENT_CODE_FIELD } from './schemas.js';
import { buildSelector } from './write-helpers.js';

/**
 * Downloading documents and attachments.
 *
 * This tool exists mainly to hide an inconsistency: `invoice/download` and
 * `pricequote/download` return named keys under the entity, while
 * `attachment/download` returns a POSITIONAL array under `success`
 * ([id, filename, base64, mimetype] — the id was only added in API 2.6.2, so
 * older integrations are off by one). Both are normalised to the same shape.
 *
 * Note there is no `creditinvoice/download` — verified against the live API.
 *
 * Endpoints:
 *   download_document → controller `invoice` / `pricequote` / `attachment`, action `download`
 */
export function registerDocumentTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'download_document',
    {
      description:
        'Download an invoice PDF, a quote PDF, or a file attached to any record — always returned as base64 in a ' +
        'uniform `{ filename, base64, mimeType }` shape. ' +
        'For `type: "invoice"` you can choose `fileType` "pdf" (default), "ubl" (e-invoicing XML) or "ublwithpdf", ' +
        'and `template` to render a work order, order confirmation, delivery note or packing slip instead of the ' +
        'invoice — those extra templates only work if enabled in the administration. ' +
        'For `type: "attachment"` identify the file by `attachmentId` or `filename`, and its parent record by ' +
        '`parentType` plus `identifier`/`code`. ' +
        'NOTE: purchase invoices cannot be downloaded — WeFact has no such action. ' +
        'Calls controller `invoice` / `pricequote` / `attachment`, action `download`.',
      inputSchema: {
        type: z
          .enum(['invoice', 'pricequote', 'attachment'])
          .describe('What to download: an invoice PDF, a quote PDF, or an attached file.'),
        identifier: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Identifier of the document, or of the attachment's parent record."),
        code: z
          .string()
          .optional()
          .describe("InvoiceCode / PriceQuoteCode, or the parent record's code for attachments."),

        fileType: z
          .enum(['pdf', 'ubl', 'ublwithpdf'])
          .optional()
          .describe('Only for type "invoice". Default "pdf". "ubl" returns the e-invoicing XML.'),
        template: z
          .enum(['invoice', 'workorder', 'confirmation', 'deliveryorder', 'packageorder'])
          .optional()
          .describe('Only for type "invoice". Default "invoice". Other templates must be enabled in WeFact.'),

        parentType: attachmentTypeArg.optional().describe('Only for type "attachment": the parent record type.'),
        attachmentId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Only for type "attachment": the attachment id. Use this or `filename`.'),
        filename: z
          .string()
          .optional()
          .describe('Only for type "attachment": the file name. Use this or `attachmentId`.'),

        administration: administrationArg,
      },
    },
    async ({ type, identifier, code, fileType, template, parentType, attachmentId, filename, administration }) =>
      guard(async () => {
        if (type === 'attachment') {
          if (!parentType) {
            throw new Error('`parentType` is required when downloading an attachment (e.g. "invoice", "debtor").');
          }
          if (attachmentId === undefined && !filename) {
            throw new Error('Provide `attachmentId` or `filename` to identify which attachment to download.');
          }

          const codeField = ATTACHMENT_PARENT_CODE_FIELD[parentType];
          if (identifier === undefined && !(code && codeField)) {
            throw new Error(
              codeField
                ? `Provide \`identifier\` (the ${parentType} id) or \`code\` (${codeField}).`
                : `\`identifier\` is required for ${parentType} attachments — this type has no code lookup.`,
            );
          }

          const envelope = await client.request({
            administration,
            ...EP.attachmentDownload,
            params: {
              Type: parentType,
              ReferenceIdentifier: identifier,
              ...(code && codeField ? { [codeField]: code } : {}),
              Identifier: attachmentId,
              Filename: filename,
            },
          });

          // Positional payload: [id, filename, base64, mimetype].
          const tuple = (envelope['success'] ?? []) as unknown[];
          return ok({
            document: {
              attachmentId: tuple[0] ?? null,
              filename: tuple[1] ?? null,
              base64: tuple[2] ?? null,
              mimeType: tuple[3] ?? null,
            },
          });
        }

        const codeField = type === 'invoice' ? 'InvoiceCode' : 'PriceQuoteCode';
        const entity = type === 'invoice' ? 'invoice' : 'price quote';
        const endpoint = type === 'invoice' ? EP.invoiceDownload : EP.priceQuoteDownload;

        const envelope = await client.request({
          administration,
          ...endpoint,
          params: {
            ...buildSelector(codeField, { identifier, code }, entity),
            ...(type === 'invoice' ? { FileType: fileType, InvoiceTemplateType: template } : {}),
          },
        });

        const payload = (envelope[type] ?? {}) as Record<string, unknown>;
        return ok({
          document: {
            filename: payload['Filename'] ?? null,
            base64: payload['Base64'] ?? null,
            mimeType: payload['MimeType'] ?? null,
          },
        });
      }),
  );
}
