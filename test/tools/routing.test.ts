import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerInvoiceWriteTools } from '../../src/tools/invoices-write.js';
import { registerPriceQuoteWriteTools } from '../../src/tools/pricequotes-write.js';
import { registerCreditInvoiceWriteTools } from '../../src/tools/creditinvoices-write.js';
import { harness, type Harness } from '../helpers/mcp-harness.js';
import { withEnv, WRITES_ON } from '../helpers/env.js';
import { EP } from '../../src/wefact-endpoints.js';

/**
 * Line-management routing.
 *
 * WeFact splits line operations across two controllers in a way its own
 * documentation gets wrong: `sortlines` is on the PARENT controller, while
 * `add`/`delete` for the very same lines are on the LINE controller. Getting it
 * wrong returns "Invalid action" — so it fails, but only at runtime, against
 * the live API, and only for the one action that was mis-routed.
 *
 * These are the assertions that would have caught the original bug.
 */

const LINE = [{ Description: 'x', PriceExcl: 1 }];
const REF = [{ Identifier: 1 }];

describe('invoice line routing', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness(registerInvoiceWriteTools);
  });
  beforeEach(() => {
    h.wefact.reset();
  });
  afterAll(async () => {
    await h.close();
  });

  it('routes add to the invoiceline controller', async () => {
    await withEnv(WRITES_ON, () =>
      h.call('manage_invoice_lines', { action: 'add', confirm: true, identifier: 1, lines: LINE }),
    );
    expect(h.wefact.route).toBe('invoiceline/add');
  });

  it('routes delete to the invoiceline controller', async () => {
    await withEnv(WRITES_ON, () =>
      h.call('manage_invoice_lines', { action: 'delete', confirm: true, identifier: 1, lines: REF }),
    );
    expect(h.wefact.route).toBe('invoiceline/delete');
  });

  it('routes sort to the PARENT invoice controller, not invoiceline', async () => {
    // The documented `invoiceline/sortlines` does not exist.
    await withEnv(WRITES_ON, () =>
      h.call('manage_invoice_lines', { action: 'sort', confirm: true, identifier: 1, lines: REF }),
    );
    expect(h.wefact.route).toBe('invoice/sortlines');
  });
});

describe('price quote line routing', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness(registerPriceQuoteWriteTools);
  });
  beforeEach(() => {
    h.wefact.reset();
  });
  afterAll(async () => {
    await h.close();
  });

  it('routes add to the pricequoteline controller', async () => {
    await withEnv(WRITES_ON, () =>
      h.call('manage_price_quote_lines', { action: 'add', confirm: true, identifier: 1, lines: LINE }),
    );
    expect(h.wefact.route).toBe('pricequoteline/add');
  });

  it('routes delete to the pricequoteline controller', async () => {
    await withEnv(WRITES_ON, () =>
      h.call('manage_price_quote_lines', { action: 'delete', confirm: true, identifier: 1, lines: REF }),
    );
    expect(h.wefact.route).toBe('pricequoteline/delete');
  });

  it('routes sort to the PARENT pricequote controller', async () => {
    await withEnv(WRITES_ON, () =>
      h.call('manage_price_quote_lines', { action: 'sort', confirm: true, identifier: 1, lines: REF }),
    );
    expect(h.wefact.route).toBe('pricequote/sortlines');
  });
});

describe('credit invoice line routing', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness(registerCreditInvoiceWriteTools);
  });
  beforeEach(() => {
    h.wefact.reset();
  });
  afterAll(async () => {
    await h.close();
  });

  it('routes add and delete to the creditinvoiceline controller', async () => {
    await withEnv(WRITES_ON, () =>
      h.call('manage_credit_invoice_lines', { action: 'add', confirm: true, identifier: 1, lines: LINE }),
    );
    expect(h.wefact.route).toBe('creditinvoiceline/add');
  });

  it('offers no sort action — WeFact has none for purchase invoices', async () => {
    const tools = await h.listTools();
    const tool = tools.find((t) => t.name === 'manage_credit_invoice_lines');
    const props = (tool!.inputSchema['properties'] ?? {}) as Record<string, { enum?: unknown[] }>;
    expect(props['action']?.enum).toEqual(['add', 'delete']);
  });
});

describe('endpoint map invariants', () => {
  // A static check over EP itself, so a careless edit is caught without an API
  // call. It encodes the rule the docs get wrong, once.
  const entries = Object.entries(EP);

  it('puts every *SortLines endpoint on the parent controller', () => {
    const offenders = entries
      .filter(([key]) => key.endsWith('SortLines'))
      .filter(([, ep]) => ep.controller.endsWith('line'))
      .map(([key, ep]) => `${key} → ${ep.controller}/${ep.action}`);
    expect(offenders, 'sortlines lives on the parent controller, never on *line').toEqual([]);
  });

  it('puts every line add/delete endpoint on a *line controller', () => {
    const offenders = entries
      .filter(([key]) => /Line(Add|Delete)$/.test(key))
      .filter(([, ep]) => !ep.controller.endsWith('line'))
      .map(([key, ep]) => `${key} → ${ep.controller}/${ep.action}`);
    expect(offenders, 'line add/delete lives on the *line controller').toEqual([]);
  });

  it('has no duplicate controller/action pairs', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [key, ep] of entries) {
      const pair = `${ep.controller}/${ep.action}`;
      const first = seen.get(pair);
      if (first) dupes.push(`${pair} defined as both ${first} and ${key}`);
      else seen.set(pair, key);
    }
    expect(dupes).toEqual([]);
  });

  it('has a non-empty controller and action for every entry', () => {
    const bad = entries.filter(([, ep]) => !ep.controller?.trim() || !ep.action?.trim()).map(([key]) => key);
    expect(bad).toEqual([]);
  });

  it('never routes to a hyphenated action — WeFact flattens URL segments', () => {
    // /invoice/cancel-schedule is action `cancelschedule`; a hyphen here means
    // someone copied the documentation URL instead of the action string.
    const hyphenated = entries.filter(([, ep]) => ep.action.includes('-')).map(([key, ep]) => `${key} → ${ep.action}`);
    expect(hyphenated).toEqual([]);
  });
});
