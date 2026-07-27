import { describe, it, expect } from 'vitest';
import nock from 'nock';
import { ORIGIN, PATH, testClient } from '../helpers/client.js';
import { withEnv } from '../helpers/env.js';

/**
 * Pagination, driven by the envelope's `totalresults`.
 *
 * The behaviour that most needs locking is the empty case: WeFact omits the
 * rows key **entirely** when a list is empty rather than returning `[]`, so any
 * code that assumes the key exists gets `undefined` and either crashes or
 * silently treats "no results" as something else.
 */

function rows(count: number, offset = 0): Array<{ id: number }> {
  return Array.from({ length: count }, (_, i) => ({ id: offset + i }));
}

/** One page of a list response. */
function page(body: Record<string, unknown>): void {
  nock(ORIGIN)
    .post(PATH)
    .reply(200, { controller: 'debtor', action: 'list', status: 'success', ...body });
}

describe('paginate', () => {
  it('returns an empty list when WeFact omits the rows key entirely', async () => {
    // This is what an empty administration actually returns — note there is no
    // `debtors` key at all.
    page({ totalresults: 0, currentresults: 0, offset: 0 });

    const result = await testClient().paginate('debtor', { itemsKey: 'debtors' });

    expect(result.items).toEqual([]);
    expect(result.totalResults).toBe(0);
    expect(result.truncated).toBe(false);
    expect(nock.pendingMocks(), 'an empty list needs exactly one request').toEqual([]);
  });

  it('fetches a single page when everything fits', async () => {
    page({ totalresults: 3, currentresults: 3, debtors: rows(3) });

    const result = await testClient().paginate('debtor', { itemsKey: 'debtors' });

    expect(result.items).toHaveLength(3);
    expect(result.fetched).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it('walks pages by offset until totalresults is satisfied', async () => {
    const offsets: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      nock(ORIGIN)
        .post(PATH, (body) => {
          offsets.push((body as { offset: number }).offset);
          return true;
        })
        .reply(200, {
          controller: 'debtor',
          action: 'list',
          status: 'success',
          totalresults: 12,
          debtors: rows(5, offsets.length * 5),
        });
    }

    const result = await testClient().paginate('debtor', { itemsKey: 'debtors', pageSize: 5 });

    expect(offsets).toEqual([0, 5, 10]);
    expect(result.items).toHaveLength(15);
    expect(result.totalResults).toBe(12);
  });

  it('stops on an empty page even when totalresults lies', async () => {
    // The only defence against an infinite loop if the count is wrong.
    page({ totalresults: 5000, debtors: rows(5) });
    page({ totalresults: 5000, debtors: [] });

    const result = await testClient().paginate('debtor', { itemsKey: 'debtors', pageSize: 5 });

    expect(result.items).toHaveLength(5);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('caps at maxItems and reports the result as truncated', async () => {
    page({ totalresults: 100, debtors: rows(10) });

    const result = await testClient().paginate('debtor', { itemsKey: 'debtors', pageSize: 10, maxItems: 6 });

    expect(result.items).toHaveLength(6);
    expect(result.fetched).toBe(6);
    expect(result.totalResults).toBe(100);
    // The caller needs to know the answer is partial, or it will reason over a
    // clipped set as if it were complete.
    expect(result.truncated).toBe(true);
  });

  it('clamps an oversized page size to WeFact’s maximum', async () => {
    let sentLimit: number | undefined;
    nock(ORIGIN)
      .post(PATH, (body) => {
        sentLimit = (body as { limit: number }).limit;
        return true;
      })
      .reply(200, { controller: 'debtor', action: 'list', status: 'success', totalresults: 1, debtors: rows(1) });

    await testClient().paginate('debtor', { itemsKey: 'debtors', pageSize: 5000 });

    expect(sentLimit).toBe(1000);
  });

  it('honours WEFACT_PAGE_SIZE', async () => {
    let sentLimit: number | undefined;
    nock(ORIGIN)
      .post(PATH, (body) => {
        sentLimit = (body as { limit: number }).limit;
        return true;
      })
      .reply(200, { controller: 'debtor', action: 'list', status: 'success', totalresults: 1, debtors: rows(1) });

    await withEnv({ WEFACT_PAGE_SIZE: '25' }, () => testClient().paginate('debtor', { itemsKey: 'debtors' }));

    expect(sentLimit).toBe(25);
  });

  it('forwards caller params alongside its own paging', async () => {
    let body: Record<string, unknown> = {};
    nock(ORIGIN)
      .post(PATH, (b) => {
        body = b as Record<string, unknown>;
        return true;
      })
      .reply(200, { controller: 'invoice', action: 'list', status: 'success', totalresults: 0 });

    await testClient().paginate('invoice', {
      itemsKey: 'invoices',
      params: { status: '2', searchat: 'DebtorCode', searchfor: 'DB10000' },
    });

    expect(body).toMatchObject({
      controller: 'invoice',
      action: 'list',
      status: '2',
      searchat: 'DebtorCode',
      searchfor: 'DB10000',
      offset: 0,
    });
  });

  it('uses a non-default action when asked', async () => {
    let action: string | undefined;
    nock(ORIGIN)
      .post(PATH, (b) => {
        action = (b as { action: string }).action;
        return true;
      })
      .reply(200, { controller: 'settings', action: 'costcategory_list', status: 'success', totalresults: 0 });

    await testClient().paginate('settings', { itemsKey: 'costcategories', action: 'costcategory_list' });

    expect(action).toBe('costcategory_list');
  });

  it('treats a non-array rows value as empty rather than crashing', async () => {
    page({ totalresults: 1, debtors: 'unexpected' });

    const result = await testClient().paginate('debtor', { itemsKey: 'debtors' });

    expect(result.items).toEqual([]);
  });

  it('propagates an API error from any page', async () => {
    page({ totalresults: 10, debtors: rows(5) });
    nock(ORIGIN)
      .post(PATH)
      .reply(200, { controller: 'debtor', action: 'list', status: 'error', errors: ['Kaboom'] });

    await expect(testClient().paginate('debtor', { itemsKey: 'debtors', pageSize: 5 })).rejects.toThrow(/Kaboom/);
  });
});
