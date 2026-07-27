import { describe, it, expect } from 'vitest';
import { buildDateFilters, buildListParams, dateRange, stripEnvelope } from '../../src/tools/schemas.js';
import { buildSelector, compact, gatedWrite, sendEnabled, writesEnabled } from '../../src/tools/write-helpers.js';
import { withEnv, WRITES_ON, WRITES_AND_SEND_ON } from '../helpers/env.js';

/**
 * The pure helpers the tool modules are assembled from. Fast, no harness — the
 * behaviour here is either right or it silently corrupts every request built on
 * top of it.
 */

describe('compact', () => {
  it('drops undefined and keeps every other falsy value', () => {
    // WeFact treats 0, '' and false as meaningful, so only undefined may go.
    expect(compact({ a: 1, b: undefined, c: 0, d: '', e: false, f: null })).toEqual({
      a: 1,
      c: 0,
      d: '',
      e: false,
      f: null,
    });
  });

  it('returns an empty object for an all-undefined input', () => {
    expect(compact({ a: undefined })).toEqual({});
  });
});

describe('buildSelector', () => {
  it('prefers the numeric identifier', () => {
    expect(buildSelector('InvoiceCode', { identifier: 4, code: 'F1' }, 'invoice')).toEqual({ Identifier: 4 });
  });

  it('falls back to the code', () => {
    expect(buildSelector('InvoiceCode', { code: 'F1' }, 'invoice')).toEqual({ InvoiceCode: 'F1' });
  });

  it('names both options when neither is supplied', () => {
    expect(() => buildSelector('DebtorCode', {}, 'debtor')).toThrow(/identifier.*DebtorCode|DebtorCode.*identifier/s);
  });

  it('treats an empty code as absent', () => {
    expect(() => buildSelector('DebtorCode', { code: '' }, 'debtor')).toThrow();
  });
});

describe('gate env parsing', () => {
  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    ['TRUE', true],
    ['  On  ', true],
    ['false', false],
    ['0', false],
    ['', false],
    ['nope', false],
  ])('reads %o as %s', async (value, expected) => {
    await withEnv({ WEFACT_ALLOW_WRITES: value, WEFACT_ALLOW_SEND: value }, () => {
      expect(writesEnabled()).toBe(expected);
      expect(sendEnabled()).toBe(expected);
    });
  });

  it('is disabled when unset', () => {
    expect(writesEnabled()).toBe(false);
    expect(sendEnabled()).toBe(false);
  });
});

describe('gatedWrite', () => {
  const base = {
    plannedKey: 'plannedThing',
    resultKey: 'thing',
    body: { A: 1 },
    execute: async () => ({ done: true }),
  };

  const parse = (r: Awaited<ReturnType<typeof gatedWrite>>) =>
    JSON.parse(r.content[0]!.text) as Record<string, unknown>;

  it('blocks and echoes the planned body when writes are off', async () => {
    const body = parse(await gatedWrite({ ...base, confirm: true }));

    expect(body['blocked']).toBe(true);
    expect(body['written']).toBe(false);
    expect(body['plannedThing']).toEqual({ A: 1 });
  });

  it('dry-runs when writes are on but confirm is absent', async () => {
    const body = await withEnv(WRITES_ON, async () => parse(await gatedWrite(base)));

    expect(body['dryRun']).toBe(true);
    expect(body['plannedThing']).toEqual({ A: 1 });
  });

  it('executes when confirmed', async () => {
    const body = await withEnv(WRITES_ON, async () => parse(await gatedWrite({ ...base, confirm: true })));

    expect(body['written']).toBe(true);
    expect(body['thing']).toEqual({ done: true });
  });

  it('uses the status key it was given', async () => {
    const body = await withEnv(WRITES_ON, async () =>
      parse(await gatedWrite({ ...base, statusKey: 'deleted', confirm: true })),
    );

    expect(body['deleted']).toBe(true);
  });

  it('says "sent" rather than "written" in a send tool dry-run', async () => {
    const body = await withEnv(WRITES_ON, async () => parse(await gatedWrite({ ...base, statusKey: 'sent' })));

    expect(body['message']).toContain('nothing was sent');
  });

  it('merges extra fields into every outcome', async () => {
    const withExtra = { ...base, extra: { note: 'hello' } };

    expect(parse(await gatedWrite(withExtra))['note']).toBe('hello');
    expect((await withEnv(WRITES_ON, async () => parse(await gatedWrite(withExtra))))['note']).toBe('hello');
  });

  it('surfaces the consequence and marks it irreversible on both blocked and dry-run', async () => {
    const risky = { ...base, consequence: 'This eats the invoice.' };

    const blocked = parse(await gatedWrite(risky));
    expect(blocked['consequence']).toBe('This eats the invoice.');
    expect(blocked['irreversible']).toBe(true);

    const dry = await withEnv(WRITES_ON, async () => parse(await gatedWrite(risky)));
    expect(dry['irreversible']).toBe(true);
  });

  it('requires the send gate on top of the write gate', async () => {
    const sending = { ...base, requiresSend: true, confirm: true };

    const writesOnly = await withEnv(WRITES_ON, async () => parse(await gatedWrite(sending)));
    expect(writesOnly['blocked']).toBe(true);
    expect(String(writesOnly['reason'])).toContain('WEFACT_ALLOW_SEND');

    const both = await withEnv(WRITES_AND_SEND_ON, async () => parse(await gatedWrite(sending)));
    expect(both['blocked']).toBeUndefined();
  });

  it('never calls execute while blocked or dry-running', async () => {
    let calls = 0;
    const counting = { ...base, execute: async () => ({ calls: ++calls }) };

    await gatedWrite({ ...counting, confirm: true });
    await withEnv(WRITES_ON, () => gatedWrite(counting));

    expect(calls).toBe(0);
  });
});

describe('date filters', () => {
  it('builds a range from either bound', () => {
    expect(dateRange('2026-01-01', '2026-01-31')).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(dateRange('2026-01-01', undefined)).toEqual({ from: '2026-01-01' });
    expect(dateRange(undefined, '2026-01-31')).toEqual({ to: '2026-01-31' });
  });

  it('returns undefined when neither bound is given, so no empty filter is sent', () => {
    expect(dateRange(undefined, undefined)).toBeUndefined();
  });

  it('nests each range under the key WeFact expects', () => {
    // The nesting is the whole point: agents get flat dateFrom/dateTo and this
    // assembles the { from, to } object WeFact requires.
    expect(
      buildDateFilters({
        dateFrom: '2026-01-01',
        dateTo: '2026-01-31',
        modifiedFrom: '2026-01-01 00:00:00',
        createdTo: '2026-02-01 00:00:00',
      }),
    ).toEqual({
      date: { from: '2026-01-01', to: '2026-01-31' },
      modified: { from: '2026-01-01 00:00:00' },
      created: { to: '2026-02-01 00:00:00' },
    });
  });

  it('omits the document-date filter for controllers that have none', () => {
    expect(buildDateFilters({ dateFrom: '2026-01-01', modifiedFrom: '2026-01-01 00:00:00' }, null)).toEqual({
      modified: { from: '2026-01-01 00:00:00' },
    });
  });

  it('uses a controller-specific date key when asked', () => {
    expect(buildDateFilters({ dateFrom: '2026-01-01' }, 'expirationdate')).toEqual({
      expirationdate: { from: '2026-01-01' },
    });
  });

  it('returns nothing when no dates were supplied', () => {
    expect(buildDateFilters({})).toEqual({});
  });
});

describe('buildListParams', () => {
  it('passes the sort and search block through', () => {
    expect(buildListParams({ sort: 'Date', order: 'DESC', searchat: 'A|B', searchfor: 'x' })).toEqual({
      sort: 'Date',
      order: 'DESC',
      searchat: 'A|B',
      searchfor: 'x',
    });
  });

  it('carries no offset or limit — paginate owns those', () => {
    // Exposing them would advertise control the caller does not have: paginate
    // sets both itself and would overwrite anything passed here.
    expect(Object.keys(buildListParams({}))).not.toContain('offset');
    expect(Object.keys(buildListParams({}))).not.toContain('limit');
  });
});

describe('stripEnvelope', () => {
  it('removes routing and pagination fields, keeping the payload', () => {
    expect(
      stripEnvelope({
        controller: 'debtor',
        action: 'list',
        status: 'success',
        date: 'x',
        totalresults: 1,
        currentresults: 1,
        offset: 0,
        filters: {},
        debtors: [{ id: 1 }],
      }),
    ).toEqual({ debtors: [{ id: 1 }] });
  });

  it('leaves an already-bare payload alone', () => {
    expect(stripEnvelope({ invoice: { id: 1 } })).toEqual({ invoice: { id: 1 } });
  });
});
