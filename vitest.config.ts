import { defineConfig } from 'vitest/config';

/**
 * Two projects, deliberately separated.
 *
 * `unit` is hermetic: `test/setup.ts` disables outbound sockets, so a test that
 * accidentally reaches the network fails in milliseconds instead of hanging for
 * the client's 30s timeout.
 *
 * `contract` calls the real WeFact API and is never collected by `npm test`.
 * WeFact requires the caller's public IP to be whitelisted and CI runners have
 * dynamic egress, so a contract test on a runner would not merely fail — it
 * would burn the per-IP daily failed-authentication cap from an unpredictable
 * address. See test/contract/setup.ts for the guard that enforces this.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/contract/**'],
          setupFiles: ['./test/setup.ts'],
          environment: 'node',
          restoreMocks: true,
          unstubEnvs: true,
        },
      },
      {
        test: {
          name: 'contract',
          include: ['test/contract/**/*.contract.test.ts'],
          setupFiles: ['./test/contract/setup.ts'],
          environment: 'node',
          testTimeout: 120_000,
          // Never race against the rate limiter.
          fileParallelism: false,
          maxConcurrency: 1,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        // Top-level await + stdio connect; its registrations are covered
        // through registerAllTools.
        'src/index.ts',
        // Data tables. The three helpers in it are covered by the tool tests.
        'src/tools/enums.ts',
        // A const object, not code.
        'src/wefact-endpoints.ts',
      ],
      thresholds: {
        // Branch coverage is the metric that matters here: every behaviour this
        // suite locks is a branch, not a line — `?? 'no'`, `action === 'sort'
        // ? …`, `httpStatus >= 500`, `type === 'attachment' ? …`.
        'src/wefact-client.ts': { statements: 95, branches: 88, functions: 100, lines: 96 },
        'src/tools/write-helpers.ts': { statements: 100, branches: 95, functions: 100, lines: 100 },
        'src/tools/result.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
        // The tool modules, where the consolidated `action`/`type` dispatches
        // live. A mis-wired arm of one of those switches is invisible at
        // runtime — the tool still exists, still validates, still returns a
        // plausible result, and calls the wrong endpoint — so this is the one
        // group worth holding to a high branch number.
        'src/tools/**/*.ts': { statements: 94, branches: 90, functions: 98, lines: 94 },
        // Global figures sit just under what the suite achieves, so they
        // ratchet: coverage cannot fall silently, but an ordinary refactor does
        // not fail CI over a rounding difference.
        statements: 95,
        branches: 92,
        functions: 98,
        lines: 96,
      },
    },
  },
});
