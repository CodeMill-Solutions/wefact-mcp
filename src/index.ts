#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WeFactClient, resolveCredentials } from './wefact-client.js';
import { registerAuthTools } from './tools/auth.js';
import { registerSettingsTools } from './tools/settings.js';
import { registerSettingsWriteTools } from './tools/settings-write.js';
import { registerDebtorTools } from './tools/debtors.js';
import { registerDebtorWriteTools } from './tools/debtors-write.js';
import { registerCreditorTools } from './tools/creditors.js';
import { registerCreditorWriteTools } from './tools/creditors-write.js';
import { registerProductTools } from './tools/products.js';
import { registerProductWriteTools } from './tools/products-write.js';
import { registerGroupTools } from './tools/groups.js';
import { registerGroupWriteTools } from './tools/groups-write.js';
import { registerInvoiceTools } from './tools/invoices.js';
import { registerInvoiceWriteTools } from './tools/invoices-write.js';
import { registerInvoiceSendTools } from './tools/invoices-send.js';
import { registerCreditInvoiceTools } from './tools/creditinvoices.js';
import { registerCreditInvoiceWriteTools } from './tools/creditinvoices-write.js';
import { registerPriceQuoteTools } from './tools/pricequotes.js';
import { registerPriceQuoteWriteTools } from './tools/pricequotes-write.js';
import { registerPriceQuoteSendTools } from './tools/pricequotes-send.js';
import { registerDocumentTools } from './tools/documents.js';
import { registerDocumentSendTools } from './tools/documents-send.js';
import { registerSubscriptionTools } from './tools/subscriptions.js';
import { registerSubscriptionWriteTools } from './tools/subscriptions-write.js';
import { registerTransactionTools } from './tools/transactions.js';
import { registerTransactionWriteTools } from './tools/transactions-write.js';
import { registerCrmTools } from './tools/crm.js';
import { registerCrmWriteTools } from './tools/crm-write.js';
import { registerAttachmentWriteTools } from './tools/attachments-write.js';
import { registerRecordWriteTools } from './tools/records-write.js';
import { writesEnabled, sendEnabled } from './tools/write-helpers.js';

// ── Credentials ───────────────────────────────────────────────────────────────
//
// Credentials come from a JSON file (label → { api_key }) and/or the
// environment. The merge + fallback logic lives in `resolveCredentials()` so the
// server, the probe scripts, and `reload_credentials` all behave the same.
//
// File format (~/.wefact/credentials.json):
//   {
//     "<administration label>": { "api_key": "..." },
//     ...
//   }
//
// One WeFact API key belongs to exactly one administration, so the label is
// purely a local selector — there is no per-request administration parameter.

const { defaultAdministration, map: credentialsMap, credentialsFilePath, fileFound } = resolveCredentials();

if (fileFound) {
  process.stderr.write(
    `[wefact-mcp] Loaded credentials for ${credentialsMap.size} administration(s) from ${credentialsFilePath}\n`,
  );
}

if (credentialsMap.size === 0) {
  process.stderr.write(
    '[wefact-mcp] Warning: no WeFact credentials configured.\n' +
      '           Set WEFACT_API_KEY (WEFACT_ADMINISTRATION is optional),\n' +
      '           or place a credentials.json at ~/.wefact/credentials.json.\n',
  );
}

// ── WeFact API client ────────────────────────────────────────────────────────

const client = new WeFactClient(defaultAdministration, credentialsMap);

// ── MCP server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'wefact-mcp',
  version: '1.0.0',
});

registerAuthTools(server, client);
registerSettingsTools(server, client);
registerSettingsWriteTools(server, client);
registerDebtorTools(server, client);
registerDebtorWriteTools(server, client);
registerCreditorTools(server, client);
registerCreditorWriteTools(server, client);
registerProductTools(server, client);
registerProductWriteTools(server, client);
registerGroupTools(server, client);
registerGroupWriteTools(server, client);
registerInvoiceTools(server, client);
registerInvoiceWriteTools(server, client);
registerInvoiceSendTools(server, client);
registerCreditInvoiceTools(server, client);
registerCreditInvoiceWriteTools(server, client);
registerPriceQuoteTools(server, client);
registerPriceQuoteWriteTools(server, client);
registerPriceQuoteSendTools(server, client);
registerDocumentTools(server, client);
registerDocumentSendTools(server, client);
registerSubscriptionTools(server, client);
registerSubscriptionWriteTools(server, client);
registerTransactionTools(server, client);
registerTransactionWriteTools(server, client);
registerCrmTools(server, client);
registerCrmWriteTools(server, client);
registerAttachmentWriteTools(server, client);
registerRecordWriteTools(server, client);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();

await server.connect(transport);

const credInfo =
  credentialsMap.size > 0
    ? `${credentialsMap.size} administration credential set(s) loaded`
    : 'no credentials configured';

const writesAllowed = writesEnabled();
const sendAllowed = sendEnabled();

process.stderr.write(
  `[wefact-mcp] Server started — 51 tools registered ` +
    `(whoami, get_settings, list_debtors, list_invoices, save_invoice, send_invoice_by_email, …, delete_record). ` +
    `Writes: ${writesAllowed ? 'ENABLED (WEFACT_ALLOW_WRITES)' : 'disabled (read-only)'}. ` +
    `Outbound email: ${sendAllowed ? 'ENABLED (WEFACT_ALLOW_SEND)' : 'disabled'}. ` +
    `Default administration: ${defaultAdministration || '(none)'} — ${credInfo}\n`,
);
