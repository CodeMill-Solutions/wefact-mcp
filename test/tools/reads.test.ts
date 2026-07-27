import { describe, it, expect, beforeEach } from 'vitest';
import { registerAllTools } from '../../src/register-tools.js';
import { harness, type Harness } from '../helpers/mcp-harness.js';
import { RecordingClient } from '../helpers/recording-client.js';

/**
 * The read side: how filters reach WeFact, and what comes back.
 *
 * Two branch families live here that the write tests never touch.
 *
 * The first is filter translation. Tools take readable arguments — `status:
 * "paid"`, `dateFrom`, `archived: true` — and convert them to WeFact's coded,
 * nested equivalents. A mistranslation does not error; it silently returns the
 * wrong rows, which is worse than failing.
 *
 * The second is the not-found arm. Every `get_*` reads its entity out of the
 * envelope and falls back to `null`, and that fallback is only exercised when
 * WeFact returns success with nothing in it.
 */

let h: Harness;

beforeEach(async () => {
  if (h) await h.close();
  h = await harness(registerAllTools, new RecordingClient());
});

/** Call a read tool and return the params it sent. */
async function params(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  h.wefact.reset();
  const r = await h.call(name, args);
  if (r.isError) throw new Error(`${name} errored: ${String(r.body?.error)}`);
  return h.wefact.params;
}

describe('status filters translate to WeFact codes', () => {
  it.each([
    ['draft', '0'],
    ['sent', '2'],
    ['partly_paid', '3'],
    ['paid', '4'],
    ['credit', '8'],
    ['expired', '9'],
  ])('list_invoices status %s → %s', async (status, code) => {
    expect((await params('list_invoices', { status }))['status']).toBe(code);
  });

  it.each([
    ['concept', '0'],
    ['sent', '2'],
    ['accepted', '3'],
    ['invoice_created', '4'],
    ['declined', '8'],
  ])('list_price_quotes status %s → %s', async (status, code) => {
    expect((await params('list_price_quotes', { status }))['status']).toBe(code);
  });

  it.each([
    ['unpaid', '1'],
    ['partly_paid', '2'],
    ['paid', '3'],
    ['credit', '8'],
  ])('list_credit_invoices status %s → %s — a different scale from sales invoices', async (status, code) => {
    expect((await params('list_credit_invoices', { status }))['status']).toBe(code);
  });

  it('omits the status filter entirely when none is given', async () => {
    expect((await params('list_invoices'))['status']).toBeUndefined();
  });
});

describe('date filters become nested from/to objects', () => {
  it('nests the invoice date range', async () => {
    const sent = await params('list_invoices', { dateFrom: '2026-01-01', dateTo: '2026-01-31' });
    expect(sent['date']).toEqual({ from: '2026-01-01', to: '2026-01-31' });
  });

  it('nests due-date and payment-date ranges under their own keys', async () => {
    const sent = await params('list_invoices', {
      payBeforeFrom: '2026-01-01',
      payBeforeTo: '2026-01-31',
      payDateFrom: '2026-02-01',
    });
    expect(sent['paybefore']).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(sent['paydate']).toEqual({ from: '2026-02-01' });
  });

  it('nests created and modified ranges', async () => {
    const sent = await params('list_debtors', {
      createdFrom: '2026-01-01 00:00:00',
      modifiedTo: '2026-02-01 00:00:00',
    });
    expect(sent['created']).toEqual({ from: '2026-01-01 00:00:00' });
    expect(sent['modified']).toEqual({ to: '2026-02-01 00:00:00' });
  });

  it('uses expirationdate for quote validity', async () => {
    const sent = await params('list_price_quotes', { expiresFrom: '2026-01-01', expiresTo: '2026-03-01' });
    expect(sent['expirationdate']).toEqual({ from: '2026-01-01', to: '2026-03-01' });
  });

  it('sends no date keys at all when no dates were given', async () => {
    const sent = await params('list_invoices');
    for (const key of ['date', 'paybefore', 'paydate', 'created', 'modified']) {
      expect(sent[key], key).toBeUndefined();
    }
  });
});

describe('other list filters', () => {
  it('maps the archived boolean to 1/0', async () => {
    expect((await params('list_price_quotes', { archived: true }))['archived']).toBe(1);
    expect((await params('list_price_quotes', { archived: false }))['archived']).toBe(0);
    expect((await params('list_price_quotes'))['archived']).toBeUndefined();
  });

  it('maps groupId onto WeFact’s `group`', async () => {
    expect((await params('list_debtors', { groupId: 3 }))['group']).toBe(3);
    expect((await params('list_products', { groupId: 4 }))['group']).toBe(4);
  });

  it('passes the subscription status through unmapped — it is already a word', async () => {
    expect((await params('list_subscriptions', { status: 'terminated' }))['status']).toBe('terminated');
  });

  it('maps the transaction direction onto transactionDirection', async () => {
    const sent = await params('list_transactions', { direction: 'incoming', status: 'unmatched' });
    expect(sent).toMatchObject({ transactionDirection: 'incoming', status: 'unmatched' });
  });

  it('scopes CRM lists by reference, including the tasks-only "unlinked"', async () => {
    const sent = await params('list_crm_records', { type: 'task', referenceType: 'unlinked' });
    expect(sent['referenceType']).toBe('unlinked');
  });

  it('sends the task status filter only for tasks', async () => {
    expect((await params('list_crm_records', { type: 'task', status: 'open' }))['status']).toBe('open');
    const asInteraction = await params('list_crm_records', {
      type: 'interaction',
      referenceType: 'debtor',
      referenceId: 1,
      status: 'open',
    });
    expect(asInteraction['status'], 'interactions have no status').toBeUndefined();
  });

  it('forwards the shared sort and search block', async () => {
    const sent = await params('list_debtors', {
      sort: 'CompanyName',
      order: 'DESC',
      searchat: 'EmailAddress',
      searchfor: 'a@b.c',
    });
    expect(sent).toMatchObject({ sort: 'CompanyName', order: 'DESC', searchat: 'EmailAddress', searchfor: 'a@b.c' });
  });
});

describe('get_* when the record does not exist', () => {
  // WeFact answers a missing record with a success envelope that simply has no
  // entity in it, so this arm is only reachable that way.
  it.each([
    ['get_debtor', { identifier: 1 }, 'debtor'],
    ['get_creditor', { identifier: 1 }, 'creditor'],
    ['get_product', { identifier: 1 }, 'product'],
    ['get_invoice', { identifier: 1 }, 'invoice'],
    ['get_price_quote', { identifier: 1 }, 'priceQuote'],
    ['get_credit_invoice', { identifier: 1 }, 'creditInvoice'],
    ['get_subscription', { identifier: 1 }, 'subscription'],
    ['get_transaction', { identifier: 1 }, 'transaction'],
  ])('%s returns null rather than undefined', async (name, args, key) => {
    h.wefact.reset().reply({});
    const r = await h.call(name, args);

    expect(r.isError).toBe(false);
    expect(r.body?.[key], `${name} should report ${key}: null`).toBeNull();
  });
});

describe('annotation of coded fields', () => {
  it('labels invoice status and sub-status on a single invoice', async () => {
    h.wefact.reset().reply({ invoice: { Status: '2', SubStatus: 'PAUSED', PaymentMethod: 'ideal' } });
    const r = await h.call('get_invoice', { identifier: 1 });

    expect(r.body?.['invoice']).toMatchObject({
      StatusLabel: 'sent',
      SubStatusLabel: 'payment process paused',
      PaymentMethodLabel: 'iDEAL',
    });
  });

  it('labels a credited invoice honestly — 9 is voided or expired', async () => {
    h.wefact.reset().reply({ invoice: { Status: '9' } });
    const r = await h.call('get_invoice', { identifier: 1 });

    expect((r.body?.['invoice'] as Record<string, unknown>)['StatusLabel']).toBe('voided or expired');
  });

  it('labels every row of a list', async () => {
    h.wefact.reset().reply({ invoices: [{ Status: '0' }, { Status: '4' }] });
    const r = await h.call('list_invoices', {});

    const rows = r.body?.['invoices'] as Array<Record<string, unknown>>;
    expect(rows.map((row) => row['StatusLabel'])).toEqual(['draft', 'paid']);
  });

  it('leaves an unrecognised code untouched rather than inventing a label', async () => {
    h.wefact.reset().reply({ invoice: { Status: '77' } });
    const r = await h.call('get_invoice', { identifier: 1 });

    const invoice = r.body?.['invoice'] as Record<string, unknown>;
    expect(invoice['Status']).toBe('77');
    expect(invoice['StatusLabel']).toBeUndefined();
  });

  it('labels the recurrence period on products and subscriptions', async () => {
    h.wefact.reset().reply({ product: { PricePeriod: 'k' } });
    expect((await h.call('get_product', { identifier: 1 })).body?.['product']).toMatchObject({
      PricePeriodLabel: 'quarter',
    });

    h.wefact.reset().reply({ subscription: { Periodic: 'j' } });
    expect((await h.call('get_subscription', { identifier: 1 })).body?.['subscription']).toMatchObject({
      PeriodicLabel: 'year',
    });
  });

  it('labels the purchase-invoice status on its own scale', async () => {
    h.wefact.reset().reply({ creditinvoice: { Status: '1' } });
    const r = await h.call('get_credit_invoice', { identifier: 1 });

    // 1 is "unpaid" here; on a sales invoice there is no status 1 at all.
    expect((r.body?.['creditInvoice'] as Record<string, unknown>)['StatusLabel']).toBe('unpaid');
  });

  it('labels how a customer wants documents delivered', async () => {
    h.wefact.reset().reply({ debtor: { DebtorCode: 'DB10000', InvoiceMethod: '5' } });
    const r = await h.call('get_debtor', { identifier: 1 });

    expect((r.body?.['debtor'] as Record<string, unknown>)['InvoiceMethodLabel']).toBe('Peppol');
  });

  it('labels bank transaction reconciliation status', async () => {
    h.wefact.reset().reply({ transaction: { Status: 'unmatched' } });
    expect((await h.call('get_transaction', { identifier: 1 })).body?.['transaction']).toMatchObject({
      StatusLabel: 'unmatched',
    });

    h.wefact.reset().reply({ transactions: [{ Status: 'matched' }, { Status: 'ignored' }] });
    const list = (await h.call('list_transactions', {})).body?.['transactions'] as Array<Record<string, unknown>>;
    expect(list.map((row) => row['StatusLabel'])).toEqual(['matched', 'ignored']);
  });

  it('labels the price quote status', async () => {
    h.wefact.reset().reply({ pricequote: { Status: '3' } });
    expect((await h.call('get_price_quote', { identifier: 1 })).body?.['priceQuote']).toMatchObject({
      StatusLabel: 'accepted',
    });
  });

  it('labels creditor and debtor list rows without inventing fields', async () => {
    h.wefact.reset().reply({ debtors: [{ DebtorCode: 'DB1' }] });
    const rows = (await h.call('list_debtors', {})).body?.['debtors'] as Array<Record<string, unknown>>;

    // No coded field present, so nothing is added.
    expect(rows[0]).toEqual({ DebtorCode: 'DB1' });
  });
});

describe('CRM listing constraints', () => {
  it('rejects the tasks-only "unlinked" reference type for interactions', async () => {
    h.wefact.reset();
    const r = await h.call('list_crm_records', { type: 'interaction', referenceType: 'unlinked', referenceId: 1 });

    expect(r.isError).toBe(true);
    expect(String(r.body?.error)).toMatch(/tasks only/);
    expect(h.wefact.calls).toHaveLength(0);
  });

  it('routes tasks and interactions to their own controllers and result keys', async () => {
    h.wefact.reset().reply({ tasks: [{ Identifier: 1 }] });
    const tasks = await h.call('list_crm_records', { type: 'task' });
    expect(h.wefact.route).toBe('task/list');
    expect(tasks.body?.['tasks']).toHaveLength(1);

    h.wefact.reset().reply({ interactions: [{ Identifier: 2 }] });
    const interactions = await h.call('list_crm_records', {
      type: 'interaction',
      referenceType: 'debtor',
      referenceId: 1,
    });
    expect(h.wefact.route).toBe('interaction/list');
    expect(interactions.body?.['interactions']).toHaveLength(1);
  });

  it('reads a task and an interaction under their own keys', async () => {
    h.wefact.reset().reply({ task: { Identifier: 1, Title: 'T' } });
    expect((await h.call('get_crm_record', { type: 'task', identifier: 1 })).body?.['task']).toMatchObject({
      Title: 'T',
    });

    h.wefact.reset().reply({ interaction: { Identifier: 2 } });
    expect(
      (await h.call('get_crm_record', { type: 'interaction', identifier: 2 })).body?.['interaction'],
    ).toMatchObject({ Identifier: 2 });
  });
});

describe('list result envelope', () => {
  it('reports count, total and truncation', async () => {
    h.wefact.reset().reply({ debtors: [{ Identifier: 1 }], totalresults: 42 });
    const r = await h.call('list_debtors', {});

    expect(r.body).toMatchObject({ count: 1, totalResults: 42, truncated: false });
  });

  it('returns an empty list when WeFact omits the rows key', async () => {
    h.wefact.reset().reply({ totalresults: 0 });
    const r = await h.call('list_debtors', {});

    expect(r.body).toMatchObject({ count: 0, debtors: [] });
  });
});

describe('whoami', () => {
  it('reports the gates and the tax codes when authenticated', async () => {
    h.wefact.reset().reply({
      settings: {
        CorporateIdentity: [{ LanguageCode: 'nl_nl', Name: 'Nederlands', Default: 'yes' }],
        Tax: { Codes: { Sale: { V21: { TaxCode: 'V21', Name: '21%', Rate: '0.210000', IsDefault: 'yes' } } } },
      },
    });
    const r = await h.call('whoami', {});

    expect(r.body).toMatchObject({ authenticated: true, writesEnabled: false, sendEnabled: false });
    expect(r.body?.['saleTaxCodes']).toEqual([{ taxCode: 'V21', name: '21%', rate: '0.210000', isDefault: 'yes' }]);
  });

  it('reports the failure kind instead of throwing when the API rejects it', async () => {
    // whoami is the tool you reach for when nothing works, so it has to answer
    // even — especially — when the call fails.
    h.wefact.reset().reply(new Error('IP not whitelisted'));
    const r = await h.call('whoami', {});

    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ authenticated: false });
    expect(r.body?.['error']).toContain('IP not whitelisted');
    expect(r.body?.['configuredAdministrations']).toEqual(['test']);
  });
});
