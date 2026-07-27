import { describe, it, expect } from 'vitest';
import nock from 'nock';
import { WeFactApiError } from '../../src/wefact-client.js';
import { api, apiError, API_KEY, ORIGIN, PATH, success, testClient } from '../helpers/client.js';
import { withEnv } from '../helpers/env.js';

/**
 * The wire contract.
 *
 * These go through real axios against a nock interceptor rather than a mocked
 * axios module, because the axios configuration *is* the subject:
 * `validateStatus: () => true` (WeFact returns 200 for errors and 403 for a
 * ban), the JSON↔form Content-Type switch, and the reserved-key guard all live
 * in that config. Replacing axios would assert the mock's behaviour instead.
 */
describe('request body and headers', () => {
  it('posts to the single WeFact endpoint with the api key, controller and action', async () => {
    let body: Record<string, unknown> | undefined;
    nock(ORIGIN)
      .post(PATH, (b) => {
        body = b as Record<string, unknown>;
        return true;
      })
      .matchHeader('content-type', 'application/json')
      .matchHeader('accept', 'application/json')
      .reply(200, success());

    await testClient().request({ controller: 'settings', action: 'list' });

    expect(body).toMatchObject({ api_key: API_KEY, controller: 'settings', action: 'list' });
  });

  it('drops only undefined params — 0, empty string and false are meaningful to WeFact', async () => {
    // WeFact uses `Status: 0` for a draft and `InvoiceMethod: ''` for "use the
    // debtor's preference", so the usual "strip empty values" reflex would
    // silently change what an invoice means. This is a deliberate divergence
    // from the sibling e-Boekhouden client.
    let body: Record<string, unknown> = {};
    nock(ORIGIN)
      .post(PATH, (b) => {
        body = b as Record<string, unknown>;
        return true;
      })
      .reply(200, success());

    await testClient().request({
      controller: 'invoice',
      action: 'add',
      params: { Status: 0, InvoiceMethod: '', Flag: false, Gone: undefined },
    });

    expect(body['Status']).toBe(0);
    expect(body['InvoiceMethod']).toBe('');
    expect(body['Flag']).toBe(false);
    expect(Object.keys(body)).not.toContain('Gone');
  });

  it('sends nested structures intact', async () => {
    let body: Record<string, unknown> = {};
    nock(ORIGIN)
      .post(PATH, (b) => {
        body = b as Record<string, unknown>;
        return true;
      })
      .reply(200, success());

    await testClient().request({
      controller: 'invoice',
      action: 'add',
      params: { InvoiceLines: [{ PriceExcl: 10 }], date: { from: '2026-01-01', to: '2026-01-31' } },
    });

    expect(body['InvoiceLines']).toEqual([{ PriceExcl: 10 }]);
    expect(body['date']).toEqual({ from: '2026-01-01', to: '2026-01-31' });
  });

  it('refuses params that would overwrite the api key or routing, without making a call', async () => {
    // No interceptor is registered: if the guard ever stopped throwing, the
    // request would hit nock's disabled-net-connect and fail loudly rather than
    // silently sending a caller-controlled api_key.
    const client = testClient();
    await expect(
      client.request({ controller: 'invoice', action: 'list', params: { api_key: 'attacker' } }),
    ).rejects.toThrow(/reserved key/i);
    await expect(
      client.request({ controller: 'invoice', action: 'list', params: { controller: 'debtor' } }),
    ).rejects.toThrow(/reserved key/i);
  });
});

describe('response handling', () => {
  it('treats a body-level error as a failure even though HTTP is 200', async () => {
    api().reply(200, apiError(['Factuur 1 niet gevonden']));
    await expect(testClient().request({ controller: 'invoice', action: 'show' })).rejects.toBeInstanceOf(
      WeFactApiError,
    );
  });

  it('returns the envelope on a non-2xx status when the body says success', async () => {
    // validateStatus is deliberately permissive so the body is always read.
    api().reply(404, success({ settings: { ok: true } }));
    const envelope = await testClient().request({ controller: 'settings', action: 'list' });
    expect(envelope['settings']).toEqual({ ok: true });
  });

  it('reports a non-JSON body as a transport problem rather than crashing', async () => {
    api().reply(200, '<html>proxy interception</html>', { 'content-type': 'text/html' });
    await expect(testClient().request({ controller: 'settings', action: 'list' })).rejects.toThrow(
      /was not JSON|not JSON/i,
    );
  });

  it('returns the error envelope instead of throwing when raw is set', async () => {
    api().reply(200, apiError(['Invalid action']));
    const envelope = await testClient().request({ controller: 'x', action: 'y', raw: true });
    expect(envelope.status).toBe('error');
    expect(envelope.errors).toEqual(['Invalid action']);
  });

  it('preserves every Dutch error line verbatim', async () => {
    const errors = ['Klant niet gevonden.', 'U dient een bedrijfsnaam op te geven.'];
    api().reply(200, apiError(errors));
    const err = await testClient()
      .request({ controller: 'debtor', action: 'edit' })
      .catch((e: unknown) => e as WeFactApiError);
    expect(err.errors).toEqual(errors);
    // WeFact ships no machine-readable codes, so the prose is the whole
    // diagnostic — it must not be truncated out of the message.
    for (const line of errors) expect(err.message).toContain(line);
  });
});

describe('WEFACT_TRANSPORT=form', () => {
  // The escape hatch for the day an endpoint rejects a JSON body. Untested it
  // would be indistinguishable from broken.
  //
  // Assertions are on the body as nock decodes it — i.e. the field names and
  // values WeFact's PHP would actually see. Comparing the raw percent-encoded
  // string instead would fail on cosmetic differences like `+` versus `%20`,
  // which mean the same thing on the wire.
  async function formBody(params: Record<string, unknown>): Promise<Record<string, string>> {
    let captured: Record<string, string> = {};
    nock(ORIGIN)
      .post(PATH, (b) => {
        captured = (typeof b === 'string' ? Object.fromEntries(new URLSearchParams(b)) : b) as Record<string, string>;
        return true;
      })
      .matchHeader('content-type', 'application/x-www-form-urlencoded')
      .reply(200, success());

    await withEnv({ WEFACT_TRANSPORT: 'form' }, () =>
      testClient().request({ controller: 'invoice', action: 'add', params }),
    );
    return captured;
  }

  it('encodes nested structures in PHP bracket notation', async () => {
    const body = await formBody({
      InvoiceLines: [{ PriceExcl: 10, Description: 'a b' }],
      date: { from: '2026-01-01' },
    });

    expect(body['InvoiceLines[0][PriceExcl]']).toBe('10');
    expect(body['InvoiceLines[0][Description]']).toBe('a b');
    expect(body['date[from]']).toBe('2026-01-01');
  });

  it('round-trips characters that would otherwise break the body', async () => {
    // An unescaped & would split the field and an unescaped + would arrive as a
    // space, so these must survive intact.
    const body = await formBody({ CompanyName: 'A&B + Zoon', City: 'Curaçao' });

    expect(body['CompanyName']).toBe('A&B + Zoon');
    expect(body['City']).toBe('Curaçao');
  });

  it('omits null and undefined values', async () => {
    const body = await formBody({ Kept: 'yes', Dropped: null, Absent: undefined });

    expect(body['Kept']).toBe('yes');
    expect(Object.keys(body)).not.toContain('Dropped');
    expect(Object.keys(body)).not.toContain('Absent');
  });
});

describe('administration selection', () => {
  it('fails clearly when no credentials exist for the requested administration', async () => {
    await expect(testClient().request({ administration: 'other', controller: 'x', action: 'y' })).rejects.toThrow(
      /No WeFact credentials configured for administration "other"/,
    );
    expect(nock.pendingMocks()).toEqual([]);
  });
});
