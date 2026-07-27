import { describe, it, expect } from 'vitest';
import { WeFactApiError, WeFactClient, resolveCredentials } from '../../src/wefact-client.js';
import { EP } from '../../src/wefact-endpoints.js';
import { CONTRACT_ENABLED } from './setup.js';

/**
 * Four live calls that confirm the assumptions this server is built on are
 * still true.
 *
 * Deliberately tiny. WeFact allows roughly 500 calls a minute per IP and bans
 * the address on a breach, so a contract suite that sweeps everything is one
 * you stop running. This is the version you can afford before every release:
 * it covers the entire documentation trap that caused the original bug, for
 * about 1% of a minute's budget.
 *
 * Every call is read-only and uses a deliberately invalid identifier, so
 * nothing is created, changed or deleted.
 */
describe.runIf(CONTRACT_ENABLED)('contract: live WeFact API', () => {
  const { defaultAdministration, map } = resolveCredentials();
  const client = new WeFactClient(defaultAdministration, map);
  const NO_SUCH_ID = 999_999_999;

  /**
   * Call an endpoint and report whether WeFact recognises it at all.
   * A "not found" means the route exists; "Invalid action"/"Invalid controller"
   * means it does not.
   */
  async function endpointExists(controller: string, action: string): Promise<boolean> {
    try {
      await client.request({ controller, action, params: { Identifier: NO_SUCH_ID } });
      return true;
    } catch (err) {
      if (err instanceof WeFactApiError) {
        if (err.kind === 'invalid-endpoint') return false;
        if (err.kind === 'firewalled' || err.kind === 'auth' || err.kind === 'ip-not-whitelisted') throw err;
        return true;
      }
      throw err;
    }
  }

  it('authenticates and returns the administration settings', async () => {
    const envelope = await client.request({ ...EP.settingsList });

    expect(envelope.status).toBe('success');
    const settings = envelope['settings'] as Record<string, unknown>;
    // These are the ids every write tool depends on; if their shape moved,
    // get_settings and whoami are quietly returning nothing useful.
    expect(settings['CorporateIdentity']).toBeDefined();
    expect((settings['Tax'] as Record<string, unknown>)['Codes']).toBeDefined();
  });

  it('keeps sortlines on the parent invoice controller', async () => {
    // The documented `invoiceline/sortlines` does not exist. If this ever
    // flips, manage_invoice_lines(action: "sort") is broken for every user.
    await expect(endpointExists(EP.invoiceSortLines.controller, EP.invoiceSortLines.action)).resolves.toBe(true);
  });

  it('keeps line add on the invoiceline controller', async () => {
    await expect(endpointExists(EP.invoiceLineAdd.controller, EP.invoiceLineAdd.action)).resolves.toBe(true);
  });

  it('keeps sortlines on the parent pricequote controller', async () => {
    await expect(endpointExists(EP.priceQuoteSortLines.controller, EP.priceQuoteSortLines.action)).resolves.toBe(true);
  });
});
