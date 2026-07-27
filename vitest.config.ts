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
        // Strict where the logic is dense. Branch coverage is the metric that
        // matters here: every regression this suite locks is a branch, not a
        // line — `?? 'no'`, `action === 'sort' ? …`, `httpStatus >= 500`.
        'src/wefact-client.ts': { statements: 85, branches: 85, functions: 90, lines: 85 },
        'src/tools/write-helpers.ts': { statements: 100, branches: 95, functions: 100, lines: 100 },
        'src/tools/result.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
        // Global numbers are a ratchet against regression, not a target. They
        // sit just below what the suite currently achieves, so coverage cannot
        // silently fall — but they are deliberately not pushed higher.
        //
        // The remaining uncovered branches are almost entirely optional-argument
        // permutations inside the 29 tool modules. Driving that number up would
        // mean a test per tool asserting it forwards each field, which
        // transcribes the implementation into a second file and locks in the
        // shape of code that should stay easy to change. The guarantee that
        // every tool is actually exercised comes instead from the structural
        // sweeps: all 51 in registration.test.ts and validation.test.ts, all 28
        // write tools through the gate matrix in write-gate.test.ts.
        statements: 85,
        branches: 65,
        functions: 95,
        lines: 85,
      },
    },
  },
});
