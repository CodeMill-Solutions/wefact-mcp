#!/usr/bin/env tsx
/**
 * Read-only existence probe for every controller/action pair this server uses.
 *
 * Usage:
 *   npm run probe
 *   npx tsx scripts/probe-endpoints.ts [administration]
 *
 * WeFact's published documentation is wrong about several controller/action
 * mappings — most notably `sortlines`, which lives on the parent controller
 * rather than the line controller. This script is how that was found, and it is
 * kept so the endpoint map in src/wefact-endpoints.ts can be re-validated after
 * any WeFact release.
 *
 * How it works: each action is called with a deliberately invalid identifier.
 * "Invalid action" / "Invalid controller" means the pair does not exist; any
 * other error (typically "… niet gevonden" or a missing-parameter complaint)
 * means it does. Nothing is created, changed or deleted.
 *
 * It costs one API call per endpoint — roughly 60 against a per-IP budget of
 * ~500/minute — so it is safe to run, but not in a loop.
 */
import 'dotenv/config';
import { WeFactClient, WeFactApiError, resolveCredentials } from '../src/wefact-client.js';
import { EP } from '../src/wefact-endpoints.js';

const administration = process.argv[2];

/** Actions that mutate data even when the identifier is bogus — never probed. */
const SKIP = new Set<string>(['transactionAdd']);

async function main(): Promise<void> {
  const { defaultAdministration, map } = resolveCredentials();
  if (map.size === 0) {
    console.error('✗ No WeFact credentials configured. Set WEFACT_API_KEY or create ~/.wefact/credentials.json.');
    process.exit(1);
  }

  const client = new WeFactClient(defaultAdministration, map);
  const target = administration ?? defaultAdministration;

  console.log(`Probing ${Object.keys(EP).length} endpoints against administration "${target}"...\n`);

  const missing: string[] = [];
  let checked = 0;

  for (const [name, endpoint] of Object.entries(EP)) {
    if (SKIP.has(name)) {
      console.log(`  ${'skipped'.padEnd(9)} ${endpoint.controller}/${endpoint.action}  (would create data)`);
      continue;
    }

    checked += 1;
    let verdict = 'exists';
    let detail = '';

    try {
      await client.request({
        administration: target,
        ...endpoint,
        params: { Identifier: 999999999 },
      });
      detail = 'succeeded unexpectedly';
    } catch (err) {
      if (err instanceof WeFactApiError) {
        if (err.kind === 'invalid-endpoint') {
          verdict = 'MISSING';
          missing.push(`${endpoint.controller}/${endpoint.action}`);
        } else if (err.kind === 'firewalled' || err.kind === 'auth' || err.kind === 'ip-not-whitelisted') {
          console.error(`\n✗ Aborting: ${err.message}`);
          process.exit(1);
        }
        detail = err.errors.join('; ').slice(0, 70);
      } else {
        detail = err instanceof Error ? err.message.slice(0, 70) : String(err);
      }
    }

    const marker = verdict === 'MISSING' ? '✗' : '✓';
    console.log(`${marker} ${verdict.padEnd(9)} ${`${endpoint.controller}/${endpoint.action}`.padEnd(40)} ${detail}`);
  }

  console.log(`\nChecked ${checked} endpoints.`);
  if (missing.length > 0) {
    console.error(`\n✗ ${missing.length} endpoint(s) do not exist in this WeFact version:`);
    for (const m of missing) console.error(`    ${m}`);
    console.error('\n  Update src/wefact-endpoints.ts and the tools that use them.');
    process.exit(1);
  }
  console.log('✓ Every controller/action pair in src/wefact-endpoints.ts exists.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
