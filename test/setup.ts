import { beforeEach, afterEach, expect } from 'vitest';
import nock from 'nock';

/**
 * Global setup for the `unit` project.
 *
 * Two hazards this defends against:
 *
 * 1. **The developer's own `.env`.** The repo root carries a real `.env`
 *    declaring every `WEFACT_*` variable, including `WEFACT_ALLOW_WRITES` and
 *    `WEFACT_ALLOW_SEND`. Anything that imports a module which pulls in
 *    `dotenv/config` would load them, and the write-gate tests would then
 *    assert the wrong posture and pass. Every `WEFACT_*` key is therefore
 *    cleared before each test; a test that needs one sets it explicitly.
 *
 * 2. **Accidental real network calls.** `disableNetConnect` turns a stray
 *    request into an immediate, clearly-named failure rather than a 30-second
 *    hang on the client's axios timeout — and guarantees no unit test can ever
 *    touch the live WeFact API.
 */
beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('WEFACT_')) delete process.env[key];
  }
  nock.cleanAll();
  nock.disableNetConnect();
});

afterEach(() => {
  // An interceptor that was never consumed means the code under test did not
  // make the call the test set up — which usually means the test is asserting
  // nothing. Fail loudly rather than passing by omission.
  const pending = nock.pendingMocks();
  nock.cleanAll();
  nock.enableNetConnect();
  expect(pending, 'unconsumed nock interceptors — the expected request was never made').toEqual([]);
});
