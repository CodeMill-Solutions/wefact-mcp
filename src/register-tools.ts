import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WeFactClient } from './wefact-client.js';
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

/**
 * Register every tool this server exposes.
 *
 * This lives apart from `index.ts` so it can be called from a test: `index.ts`
 * loads dotenv, resolves credentials and connects a stdio transport at module
 * top level, so importing it starts a server. Keeping the registration list
 * here means the test suite drives the *real* tool set rather than a
 * hand-maintained copy of it, and a newly added module cannot slip through
 * untested.
 */
export function registerAllTools(server: McpServer, client: WeFactClient): void {
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
}

/**
 * How many tools `registerAllTools` registers.
 *
 * The MCP SDK exposes no public way to count registered tools, so this is a
 * literal — but it is not a promise made on trust: `test/tools/registration.test.ts`
 * asserts the real registered set matches it, so adding a tool without updating
 * this number fails the build rather than quietly making the startup banner lie.
 */
export const TOOL_COUNT = 51;
