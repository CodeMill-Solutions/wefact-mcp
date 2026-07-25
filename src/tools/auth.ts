import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WeFactClient, loadCredentialsFile, WeFactApiError } from '../wefact-client.js';
import { EP } from '../wefact-endpoints.js';
import { ok, guard } from './result.js';
import { administrationArg } from './schemas.js';
import { writesEnabled, sendEnabled } from './write-helpers.js';

/**
 * Connection and credential tools.
 *
 * WeFact has no server-side "list my administrations" endpoint — one API key
 * belongs to exactly one administration — so the administration picture is
 * purely local configuration and is reported by `whoami` rather than by a
 * separate tool.
 *
 * Endpoints:
 *   whoami             → controller `settings`, action `list`
 *   reload_credentials → local only, no API call
 */
export function registerAuthTools(server: McpServer, client: WeFactClient): void {
  server.registerTool(
    'whoami',
    {
      description:
        'Verify the WeFact connection end-to-end and report what this server can do. Calls the parameterless ' +
        '`settings/list` probe and returns the corporate identities (used as LanguageCode on documents), the ' +
        'sale and purchase VAT codes (V21, I21, …) that write tools need, the current API rate-limit headroom, ' +
        'the configured administration labels, and whether writes and outbound email are enabled. ' +
        'Run this first when anything fails: it distinguishes a rejected API key from a non-whitelisted IP ' +
        'from a rate-limit ban. Calls controller `settings`, action `list`.',
      inputSchema: {
        administration: administrationArg,
      },
    },
    async ({ administration }) =>
      guard(async () => {
        const target = administration ?? client.defaultAdministrationName;

        let authenticated = false;
        let settings: Record<string, unknown> = {};
        let error: string | undefined;
        let errorKind: string | undefined;

        try {
          const envelope = await client.request({ administration, ...EP.settingsList });
          settings = (envelope['settings'] ?? {}) as Record<string, unknown>;
          authenticated = true;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          errorKind = err instanceof WeFactApiError ? err.kind : 'unknown';
        }

        const tax = (settings['Tax'] ?? {}) as Record<string, unknown>;
        const codes = (tax['Codes'] ?? {}) as Record<string, Record<string, Record<string, string>>>;
        const taxCodes = (direction: 'Sale' | 'Purchase'): Array<Record<string, string>> =>
          Object.values(codes[direction] ?? {}).map((c) => ({
            taxCode: c['TaxCode'] ?? '',
            name: c['Name'] ?? '',
            rate: c['Rate'] ?? '',
            isDefault: c['IsDefault'] ?? 'no',
          }));

        return ok({
          authenticated,
          ...(error ? { error, errorKind } : {}),
          administration: target,
          configuredAdministrations: client.listAdministrationNames(),
          defaultAdministration: client.defaultAdministrationName,
          writesEnabled: writesEnabled(),
          sendEnabled: sendEnabled(),
          rateLimit: client.getRateLimit(administration) ?? null,
          ...(authenticated
            ? {
                corporateIdentities: settings['CorporateIdentity'] ?? [],
                saleTaxCodes: taxCodes('Sale'),
                purchaseTaxCodes: taxCodes('Purchase'),
              }
            : {}),
        });
      }),
  );

  server.registerTool(
    'reload_credentials',
    {
      description:
        'Reload the administration → API-key map from the credentials JSON file without restarting the server. ' +
        'Returns a diff of added, updated and removed administration labels. Useful after adding a new client ' +
        'administration to ~/.wefact/credentials.json. Does not call the WeFact API.',
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            'Explicit path to the credentials file. Defaults to WEFACT_CREDENTIALS_FILE, then ' +
              '~/.wefact/credentials.json, then ./credentials.json.',
          ),
      },
    },
    async ({ path }) =>
      guard(async () => {
        const loaded = loadCredentialsFile(path);
        if (!loaded.found) {
          throw new Error(
            `No credentials file found at ${loaded.path}. Create it, or pass an explicit \`path\`. ` +
              'Format: { "<label>": { "api_key": "..." } }',
          );
        }
        const diff = client.reloadCredentials(loaded.map);
        return ok({
          reloaded: true,
          credentialsFilePath: loaded.path,
          ...diff,
          administrations: client.listAdministrationNames(),
        });
      }),
  );
}
