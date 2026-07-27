import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerAllTools } from '../../src/register-tools.js';
import { registerInvoiceWriteTools } from '../../src/tools/invoices-write.js';
import { registerPriceQuoteWriteTools } from '../../src/tools/pricequotes-write.js';
import { registerCreditInvoiceWriteTools } from '../../src/tools/creditinvoices-write.js';
import { harness, type Harness } from '../helpers/mcp-harness.js';
import { RecordingClient } from '../helpers/recording-client.js';
import { argsFor } from '../helpers/tool-fixtures.js';
import { withEnv, WRITES_ON } from '../helpers/env.js';

/**
 * Places where this server deliberately overrides a WeFact default, and the
 * one place it coerces a value WeFact will not accept as-is.
 *
 * Each of these is a single `??` or `.transform` in the source. Deleting one
 * changes nothing visible: the call still succeeds, and the damage (moved
 * stock, a stale total, a rejected line) shows up somewhere else entirely.
 */

const LINE = [{ Description: 'x', PriceExcl: 10, Number: 1 }];

describe('UseProductInventory', () => {
  // WeFact defaults this to "yes", so creating an invoice silently decrements
  // stock. Invoicing should not move inventory unless someone asked for it.
  let h: Harness;
  beforeAll(async () => {
    h = await harness([registerInvoiceWriteTools, registerPriceQuoteWriteTools]);
  });
  beforeEach(() => {
    h.wefact.reset();
  });
  afterAll(async () => {
    await h.close();
  });

  it('defaults to "no" on save_invoice', async () => {
    const r = await withEnv(WRITES_ON, () =>
      h.call('save_invoice', { action: 'add', confirm: true, DebtorCode: 'DB10000', InvoiceLines: LINE }),
    );
    expect(h.wefact.params['UseProductInventory']).toBe('no');
    expect(r.body?.inventoryAffected).toBe(false);
  });

  it('defaults to "no" on save_price_quote', async () => {
    await withEnv(WRITES_ON, () =>
      h.call('save_price_quote', { action: 'add', confirm: true, DebtorCode: 'DB10000', PriceQuoteLines: LINE }),
    );
    expect(h.wefact.params['UseProductInventory']).toBe('no');
  });

  it('passes an explicit "yes" through and reports it', async () => {
    const r = await withEnv(WRITES_ON, () =>
      h.call('save_invoice', {
        action: 'add',
        confirm: true,
        DebtorCode: 'DB10000',
        InvoiceLines: LINE,
        UseProductInventory: 'yes',
      }),
    );
    expect(h.wefact.params['UseProductInventory']).toBe('yes');
    expect(r.body?.inventoryAffected).toBe(true);
  });
});

describe('RecalculateInclTotalAmount', () => {
  // WeFact defaults this to "no", which leaves AmountIncl stale and silently
  // inconsistent with the lines after an edit.
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

  it('defaults to "yes"', async () => {
    await withEnv(WRITES_ON, () =>
      h.call('manage_credit_invoice_lines', {
        action: 'add',
        confirm: true,
        identifier: 1,
        lines: [{ Description: 'x', PriceExcl: 10 }],
      }),
    );
    expect(h.wefact.params['RecalculateInclTotalAmount']).toBe('yes');
  });

  it('honours an explicit "no" for callers preserving the supplier total', async () => {
    await withEnv(WRITES_ON, () =>
      h.call('manage_credit_invoice_lines', {
        action: 'add',
        confirm: true,
        identifier: 1,
        lines: [{ Description: 'x', PriceExcl: 10 }],
        recalculateTotal: 'no',
      }),
    );
    expect(h.wefact.params['RecalculateInclTotalAmount']).toBe('no');
  });
});

describe('CostCategory coercion', () => {
  // WeFact documents this as an int but rejects a JSON number outright with
  // "Invalid type for 'InvoiceLines[0].CostCategory'". The coercion lives in a
  // zod .transform, which only runs because the MCP SDK validates server-side.
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

  const send = (CostCategory: unknown) =>
    withEnv(WRITES_ON, () =>
      h.call('save_credit_invoice', {
        action: 'add',
        confirm: true,
        CreditorCode: 'CD50000',
        InvoiceCode: 'T-1',
        InvoiceLines: [{ Description: 'x', PriceExcl: 10, TaxCode: 'I21', CostCategory }],
      }),
    );

  const sentCostCategory = (): unknown => {
    const lines = h.wefact.params['InvoiceLines'] as Array<Record<string, unknown>>;
    return lines[0]!['CostCategory'];
  };

  it('coerces a number to a string', async () => {
    await send(7);
    expect(sentCostCategory()).toBe('7');
  });

  it('leaves a string alone', async () => {
    await send('7');
    expect(sentCostCategory()).toBe('7');
  });

  it('coerces 0 to "0" rather than dropping it', async () => {
    // 0 is falsy and "none" is a meaningful value — this is the case a naive
    // truthiness check would silently lose.
    await send(0);
    expect(sentCostCategory()).toBe('0');
  });
});

describe('Identifier on create', () => {
  // WeFact rejects an Identifier on an `add` that creates a new record:
  // "Een Identifier is niet toegestaan voor deze actie."
  //
  // The `manage_*_lines` tools look identical in the schema — they also take an
  // `action` enum containing 'add' and an `identifier` — but there the
  // identifier selects the PARENT document the lines are added to, and WeFact
  // requires it. The two cases are told apart by the presence of a `lines`
  // property, so both are asserted rather than one being quietly excluded.
  async function toolsWithAddAndIdentifier() {
    const probe = await harness(registerAllTools, new RecordingClient());
    const tools = await probe.listTools();
    await probe.close();
    return tools
      .filter((t) => {
        const props = (t.inputSchema['properties'] ?? {}) as Record<string, { enum?: unknown[] }>;
        return Array.isArray(props['action']?.enum) && props['action'].enum.includes('add') && 'identifier' in props;
      })
      .map((t) => ({
        name: t.name,
        addsToParent: 'lines' in ((t.inputSchema['properties'] ?? {}) as Record<string, unknown>),
      }));
  }

  it('is dropped by every tool whose "add" creates a new record', async () => {
    const candidates = (await toolsWithAddAndIdentifier()).filter((t) => !t.addsToParent);
    expect(candidates.length, 'expected several entity-creating tools').toBeGreaterThan(5);

    for (const { name } of candidates) {
      const h = await harness(registerAllTools, new RecordingClient());
      try {
        const r = await withEnv(WRITES_ON, () =>
          h.call(name, { ...argsFor(name), action: 'add', identifier: 999, confirm: true }),
        );
        expect(r.isError, `${name}: ${r.body?.error}`).toBe(false);
        expect(Object.keys(h.wefact.params), `${name} must not send Identifier on add`).not.toContain('Identifier');
      } finally {
        await h.close();
      }
    }
  });

  it('is kept by every tool whose "add" appends to an existing parent', async () => {
    const candidates = (await toolsWithAddAndIdentifier()).filter((t) => t.addsToParent);
    expect(candidates.map((t) => t.name).sort()).toEqual([
      'manage_credit_invoice_lines',
      'manage_invoice_lines',
      'manage_price_quote_lines',
    ]);

    for (const { name } of candidates) {
      const h = await harness(registerAllTools, new RecordingClient());
      try {
        await withEnv(WRITES_ON, () => h.call(name, { ...argsFor(name), confirm: true }));
        expect(h.wefact.params['Identifier'], `${name} must send the parent Identifier`).toBe(1);
      } finally {
        await h.close();
      }
    }
  });
});
