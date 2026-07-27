#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WeFactClient, resolveCredentials } from './wefact-client.js';
import { registerAllTools, TOOL_COUNT } from './register-tools.js';
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

registerAllTools(server, client);

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
  `[wefact-mcp] Server started — ${TOOL_COUNT} tools registered ` +
    `(whoami, get_settings, list_debtors, list_invoices, save_invoice, send_invoice_by_email, …, delete_record). ` +
    `Writes: ${writesAllowed ? 'ENABLED (WEFACT_ALLOW_WRITES)' : 'disabled (read-only)'}. ` +
    `Outbound email: ${sendAllowed ? 'ENABLED (WEFACT_ALLOW_SEND)' : 'disabled'}. ` +
    `Default administration: ${defaultAdministration || '(none)'} — ${credInfo}\n`,
);
