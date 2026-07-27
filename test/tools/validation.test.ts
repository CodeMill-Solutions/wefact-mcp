import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerAllTools } from '../../src/register-tools.js';
import { registerTransactionWriteTools } from '../../src/tools/transactions-write.js';
import { registerInvoiceWriteTools } from '../../src/tools/invoices-write.js';
import { registerInvoiceTools } from '../../src/tools/invoices.js';
import { registerCrmTools } from '../../src/tools/crm.js';
import { harness, type Harness } from '../helpers/mcp-harness.js';
import { RecordingClient } from '../helpers/recording-client.js';
import { TOOL_ARGS, argsFor } from '../helpers/tool-fixtures.js';
import { withEnv, WRITES_ON } from '../helpers/env.js';
import { ok, fail, guard } from '../../src/tools/result.js';

describe('result helpers', () => {
  it('ok() produces one JSON text block with success: true', () => {
    const r = ok({ count: 2 });
    expect(r.isError).toBeUndefined();
    expect(r.content).toHaveLength(1);
    expect(JSON.parse(r.content[0]!.text)).toEqual({ success: true, count: 2 });
  });

  it('fail() flags isError and carries the message', () => {
    const r = fail(new Error('boom'), { hint: 'x' });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text)).toEqual({ success: false, error: 'boom', hint: 'x' });
  });

  it('fail() stringifies a non-Error', () => {
    expect(JSON.parse(fail('plain string').content[0]!.text).error).toBe('plain string');
  });

  it('guard() converts a thrown error into a fail result', async () => {
    const r = await guard(async () => {
      throw new Error('inside');
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).error).toBe('inside');
  });
});

describe('create_transaction amount sign', () => {
  // WeFact carries the direction of a bank transaction in the sign of the
  // amount and rejects a mismatch. Catching it locally costs nothing and beats
  // a round trip that returns Dutch prose.
  let h: Harness;
  beforeAll(async () => {
    h = await harness(registerTransactionWriteTools);
  });
  afterAll(async () => {
    await h.close();
  });

  const base = {
    bankAccount: 'NL91ABNA0417164300',
    date: '2099-01-01',
    currency: 'EUR',
    confirm: true,
  };

  it.each([
    ['withdrawal', 9.99],
    ['reversal', 9.99],
  ])('rejects a positive amount for %s and names the corrected value', async (type, amount) => {
    const r = await withEnv(WRITES_ON, () => h.call('create_transaction', { ...base, type, amount }));
    expect(r.isError).toBe(true);
    expect(r.body?.error).toContain('must be negative');
    expect(r.body?.error).toContain('-9.99');
    expect(h.wefact.calls).toHaveLength(0);
  });

  it.each([
    ['deposit', -5],
    ['batch', -5],
  ])('rejects a negative amount for %s', async (type, amount) => {
    const r = await withEnv(WRITES_ON, () => h.call('create_transaction', { ...base, type, amount }));
    expect(r.isError).toBe(true);
    expect(r.body?.error).toContain('must be positive');
    expect(h.wefact.calls).toHaveLength(0);
  });

  it.each([
    ['withdrawal', -9.99],
    ['deposit', 9.99],
  ])('accepts the correct sign for %s', async (type, amount) => {
    const r = await withEnv(WRITES_ON, () => h.call('create_transaction', { ...base, type, amount }));
    expect(r.isError).toBe(false);
    expect(r.body?.dryRun).toBeUndefined();
  });

  it('accepts zero for every type — the boundary is > 0 / < 0, not >= / <=', async () => {
    for (const type of ['withdrawal', 'deposit', 'reversal', 'batch']) {
      const r = await withEnv(WRITES_ON, () => h.call('create_transaction', { ...base, type, amount: 0 }));
      expect(r.isError, `${type} with amount 0`).toBe(false);
    }
  });
});

describe('selector guards', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness([registerInvoiceTools, registerInvoiceWriteTools]);
  });
  afterAll(async () => {
    await h.close();
  });

  it('rejects a lookup with neither identifier nor code', async () => {
    const r = await h.call('get_invoice', {});
    expect(r.isError).toBe(true);
    expect(r.body?.error).toContain('identifier');
    expect(r.body?.error).toContain('InvoiceCode');
  });

  it('treats an empty-string code as absent', async () => {
    const r = await h.call('get_invoice', { code: '' });
    expect(r.isError).toBe(true);
  });

  it('prefers identifier over code when both are given', async () => {
    await h.call('get_invoice', { identifier: 7, code: 'F2026-0001' });
    expect(h.wefact.params).toEqual({ Identifier: 7 });
  });
});

describe('save_invoice creation guards', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness(registerInvoiceWriteTools);
  });
  afterAll(async () => {
    await h.close();
  });

  it('requires a customer', async () => {
    const r = await withEnv(WRITES_ON, () =>
      h.call('save_invoice', { action: 'add', confirm: true, InvoiceLines: [{ Description: 'x', PriceExcl: 1 }] }),
    );
    expect(r.isError).toBe(true);
    expect(r.body?.error).toMatch(/Debtor/);
  });

  it('requires at least one line', async () => {
    const r = await withEnv(WRITES_ON, () =>
      h.call('save_invoice', { action: 'add', confirm: true, DebtorCode: 'DB10000' }),
    );
    expect(r.isError).toBe(true);
    expect(r.body?.error).toMatch(/InvoiceLines/);
  });

  it('rejects an empty line array', async () => {
    const r = await withEnv(WRITES_ON, () =>
      h.call('save_invoice', { action: 'add', confirm: true, DebtorCode: 'DB10000', InvoiceLines: [] }),
    );
    expect(r.isError).toBe(true);
  });

  it('names the 1-based line index when a line op is missing an Identifier', async () => {
    const r = await withEnv(WRITES_ON, () =>
      h.call('manage_invoice_lines', {
        action: 'delete',
        confirm: true,
        identifier: 1,
        lines: [{ Identifier: 5 }, { Description: 'no id here' }],
      }),
    );
    expect(r.isError).toBe(true);
    // Second entry in the array — an agent reading "Line 1" would look at the
    // wrong one.
    expect(r.body?.error).toContain('Line 2');
  });
});

describe('list filter guards', () => {
  it('refuses debtorCode combined with a custom search', async () => {
    const h = await harness(registerInvoiceTools);
    const r = await h.call('list_invoices', { debtorCode: 'DB10000', searchat: 'InvoiceCode' });
    expect(r.isError).toBe(true);
    expect(r.body?.error).toContain('cannot be combined');
    expect(h.wefact.calls).toHaveLength(0);
    await h.close();
  });

  it('rewrites debtorCode into a WeFact search', async () => {
    const h = await harness(registerInvoiceTools);
    await h.call('list_invoices', { debtorCode: 'DB10000' });
    expect(h.wefact.params).toMatchObject({ searchat: 'DebtorCode', searchfor: 'DB10000' });
    await h.close();
  });

  it('requires referenceId and referenceType to list interactions', async () => {
    // WeFact genuinely cannot list all interactions; the guard exists so an
    // agent gets a usable instruction instead of a Dutch API error.
    const h = await harness(registerCrmTools);
    const r = await h.call('list_crm_records', { type: 'interaction' });
    expect(r.isError).toBe(true);
    expect(r.body?.error).toContain('referenceId');
    expect(r.body?.error).toContain('referenceType');
    expect(h.wefact.calls).toHaveLength(0);
    await h.close();
  });

  it('lists tasks without a reference', async () => {
    const h = await harness(registerCrmTools);
    const r = await h.call('list_crm_records', { type: 'task' });
    expect(r.isError).toBe(false);
    await h.close();
  });
});

describe('every tool returns a well-formed result', () => {
  // A cheap sweep that catches a whole class of copy-paste breakage: a tool
  // that returns the wrong shape, throws outside `guard`, or emits more than
  // one content block.
  it.each(Object.keys(TOOL_ARGS).sort())('%s returns exactly one JSON text block', async (name) => {
    const client = new RecordingClient();
    const h = await harness(registerAllTools, client);
    try {
      const r = await h.call(name, argsFor(name));
      expect(r.text, `${name} returned no text content`).not.toBe('');
      expect(r.body, `${name} returned non-JSON: ${r.text.slice(0, 120)}`).toBeDefined();
      expect(typeof r.body!['success'], `${name} has no boolean success`).toBe('boolean');
    } finally {
      await h.close();
    }
  });
});
