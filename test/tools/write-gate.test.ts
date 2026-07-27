import { describe, it, expect } from 'vitest';
import { registerAllTools } from '../../src/register-tools.js';
import { registerTransactionWriteTools } from '../../src/tools/transactions-write.js';
import { harness } from '../helpers/mcp-harness.js';
import { RecordingClient } from '../helpers/recording-client.js';
import { argsFor, SEND_TOOLS, writeToolNames } from '../helpers/tool-fixtures.js';
import { withEnv, WRITES_ON, WRITES_AND_SEND_ON } from '../helpers/env.js';
import { WRITES_DISABLED_REASON, SEND_DISABLED_REASON } from '../../src/tools/write-helpers.js';

/**
 * The safety posture, asserted across every write tool rather than sampled.
 *
 * The assertion that matters most in each case is `calls).toHaveLength(0)`: a
 * gate that returns the right JSON but still hit the API would look correct in
 * any test that only inspected the response body.
 */

const WRITE_TOOLS = writeToolNames();
const SEND = new Set<string>(SEND_TOOLS);

async function withTool<T>(name: string, fn: (h: Awaited<ReturnType<typeof harness>>) => Promise<T>): Promise<T> {
  const h = await harness(registerAllTools, new RecordingClient());
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

describe('write gate', () => {
  it('covers every write tool', () => {
    // 28 write tools; if this number moves, the sweeps below moved with it.
    expect(WRITE_TOOLS.length).toBe(28);
  });

  describe.each(WRITE_TOOLS)('%s', (name) => {
    it('is blocked when WEFACT_ALLOW_WRITES is unset, and makes no API call', async () => {
      await withTool(name, async (h) => {
        const r = await h.call(name, { ...argsFor(name), confirm: true });
        expect(r.isError).toBe(false);
        expect(r.body?.blocked, 'must report blocked').toBe(true);
        expect(r.body?.reason).toBe(WRITES_DISABLED_REASON);
        expect(h.wefact.calls, 'a blocked write must not reach the API').toHaveLength(0);
      });
    });

    it('is a dry-run when writes are on but confirm is absent, and makes no API call', async () => {
      if (SEND.has(name)) return; // covered by the send-gate block below
      await withTool(name, async (h) => {
        const r = await withEnv(WRITES_ON, () => h.call(name, argsFor(name)));
        expect(r.isError).toBe(false);
        expect(r.body?.dryRun, 'must report dryRun').toBe(true);
        expect(h.wefact.calls, 'a dry-run must not reach the API').toHaveLength(0);
        // The preview must show what would be sent, or it is not a preview.
        const plannedKey = Object.keys(r.body!).find((k) => k.startsWith('planned'));
        expect(plannedKey, `${name} has no planned* key in its dry-run`).toBeDefined();
        expect(r.body![plannedKey!]).toBeTypeOf('object');
      });
    });

    it('reaches the API when writes are on and confirm is true', async () => {
      const env = SEND.has(name) ? WRITES_AND_SEND_ON : WRITES_ON;
      await withTool(name, async (h) => {
        const r = await withEnv(env, () => h.call(name, { ...argsFor(name), confirm: true }));
        expect(r.isError, `${name} errored: ${r.body?.error}`).toBe(false);
        expect(r.body?.blocked).toBeUndefined();
        expect(r.body?.dryRun).toBeUndefined();
        expect(h.wefact.calls.length, `${name} should make exactly one call`).toBe(1);
      });
    });
  });
});

describe('send gate', () => {
  it('covers every outbound-email tool', () => {
    expect(SEND_TOOLS.length).toBe(4);
  });

  describe.each(SEND_TOOLS)('%s', (name) => {
    it('stays blocked with writes on but send off — even with confirm: true', async () => {
      // This is the assertion that protects real customers' inboxes. Enabling
      // ordinary writes must never imply permission to email anyone, and a
      // caller passing `confirm` must not be able to talk its way past it.
      await withTool(name, async (h) => {
        const r = await withEnv(WRITES_ON, () => h.call(name, { ...argsFor(name), confirm: true }));
        expect(r.body?.blocked).toBe(true);
        expect(r.body?.reason).toBe(SEND_DISABLED_REASON);
        expect(h.wefact.calls, 'no email tool may reach the API without WEFACT_ALLOW_SEND').toHaveLength(0);
      });
    });

    it('states its irreversible consequence in the blocked response', async () => {
      // An agent showing a user why it stopped should be able to say what would
      // have happened.
      await withTool(name, async (h) => {
        const r = await withEnv(WRITES_ON, () => h.call(name, argsFor(name)));
        expect(r.body?.consequence, `${name} must explain what sending does`).toBeTypeOf('string');
        expect(r.body?.irreversible).toBe(true);
      });
    });
  });
});

describe('match_transaction customer notification', () => {
  // A reversal that notifies the client emails them, but the flag is buried
  // inside the `matches` array rather than being its own tool, so the gate has
  // to live in the handler.
  const notifyingMatch = {
    identifier: 1,
    confirm: true,
    matches: [
      {
        ReferenceId: 1,
        ReferenceType: 'invoice',
        MatchedAmount: 100,
        Currency: 'EUR',
        PaymentType: 'received',
        Reversal: { Reason: 'storno', NotifyClient: 'yes' },
      },
    ],
  };

  it('refuses NotifyClient: "yes" when WEFACT_ALLOW_SEND is off', async () => {
    const h = await harness(registerTransactionWriteTools);
    const r = await withEnv(WRITES_ON, () => h.call('match_transaction', notifyingMatch));
    expect(r.isError).toBe(true);
    expect(r.body?.error).toContain('WEFACT_ALLOW_SEND');
    expect(h.wefact.calls).toHaveLength(0);
    await h.close();
  });

  it('allows it once WEFACT_ALLOW_SEND is on', async () => {
    const h = await harness(registerTransactionWriteTools);
    const r = await withEnv(WRITES_AND_SEND_ON, () => h.call('match_transaction', notifyingMatch));
    expect(r.isError).toBe(false);
    expect(h.wefact.calls).toHaveLength(1);
    await h.close();
  });

  it('does not require the send gate for an ordinary match', async () => {
    const h = await harness(registerTransactionWriteTools);
    const r = await withEnv(WRITES_ON, () => h.call('match_transaction', argsFor('match_transaction')));
    expect(r.body?.dryRun).toBe(true);
    await h.close();
  });
});

describe('gate env parsing', () => {
  it.each(['true', '1', 'yes', 'on', 'TRUE', ' Yes '])('treats %o as enabled', async (value) => {
    const h = await harness(registerAllTools, new RecordingClient());
    const r = await withEnv({ WEFACT_ALLOW_WRITES: value }, () => h.call('save_debtor', argsFor('save_debtor')));
    expect(r.body?.blocked).toBeUndefined();
    expect(r.body?.dryRun).toBe(true);
    await h.close();
  });

  it.each(['false', '0', 'no', 'off', '', 'maybe'])('treats %o as disabled', async (value) => {
    const h = await harness(registerAllTools, new RecordingClient());
    const r = await withEnv({ WEFACT_ALLOW_WRITES: value }, () => h.call('save_debtor', argsFor('save_debtor')));
    expect(r.body?.blocked).toBe(true);
    await h.close();
  });
});
