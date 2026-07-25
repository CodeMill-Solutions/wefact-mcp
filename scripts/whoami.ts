#!/usr/bin/env tsx
/**
 * Verify that this machine can talk to WeFact, and print the ids every write
 * tool needs.
 *
 * Usage:
 *   npm run whoami
 *   npx tsx scripts/whoami.ts [administration]
 *
 * It deliberately prints the machine's public IP first: a non-whitelisted IP is
 * by far the most common failure, and the user cannot fix it without knowing
 * which address to whitelist.
 */
import 'dotenv/config';
import axios from 'axios';
import { WeFactClient, WeFactApiError, resolveCredentials } from '../src/wefact-client.js';

const administration = process.argv[2];

async function publicIp(): Promise<string | undefined> {
  try {
    const res = await axios.get<{ ip: string }>('https://api.ipify.org?format=json', { timeout: 3000 });
    return res.data?.ip;
  } catch {
    return undefined;
  }
}

function reportFailure(err: unknown): void {
  if (err instanceof WeFactApiError) {
    switch (err.kind) {
      case 'ip-not-whitelisted':
        console.error('\n✗ IP NOT WHITELISTED');
        console.error('  Add the public IP printed above under Instellingen → API in WeFact.');
        console.error('  Nothing else will work until you do.');
        break;
      case 'firewalled':
        console.error('\n✗ IP FIREWALLED by the rate limiter');
        console.error(`  Wait until ${err.rateLimit?.resetHourAt ?? 'the limit resets'} before trying again.`);
        console.error('  Do NOT re-run this script in a loop — further calls extend the ban.');
        break;
      case 'auth':
        console.error('\n✗ API KEY REJECTED');
        console.error('  Check WEFACT_API_KEY or ~/.wefact/credentials.json.');
        console.error('  There is a separate daily cap on failed attempts, so fix the key rather than retrying.');
        break;
      default:
        console.error(`\n✗ ${err.message}`);
    }
    return;
  }
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
}

async function main(): Promise<void> {
  const ip = await publicIp();
  if (ip) {
    console.log(`Public IP: ${ip}`);
    console.log('  This address must be whitelisted under Instellingen → API in WeFact.\n');
  }

  const { defaultAdministration, map, credentialsFilePath, fileFound } = resolveCredentials();

  if (fileFound) {
    console.log(`✓ Credentials file: ${credentialsFilePath} (${map.size} administration(s))`);
  }
  if (map.size === 0) {
    console.error('✗ No WeFact credentials configured.');
    console.error('  Set WEFACT_API_KEY, or place a credentials.json at ~/.wefact/credentials.json.');
    process.exit(1);
  }

  const target = administration ?? defaultAdministration;
  console.log(`• Administrations: ${Array.from(map.keys()).join(', ')}`);
  console.log(`• Using: ${target}\n`);

  const client = new WeFactClient(defaultAdministration, map);

  // 1. The parameterless settings probe — cheapest possible authenticated call.
  const settings = await client.request({ administration: target, ...{ controller: 'settings', action: 'list' } });
  const payload = (settings['settings'] ?? {}) as Record<string, unknown>;
  console.log('✓ Authenticated — settings/list succeeded');

  const identities = (payload['CorporateIdentity'] ?? []) as Array<Record<string, string>>;
  if (identities.length > 0) {
    console.log('\n  Corporate identities (use as LanguageCode):');
    for (const ci of identities) {
      const flag = ci['Default'] === 'yes' ? ' (default)' : '';
      console.log(`    ${ci['LanguageCode']}  ${ci['Name']}${flag}`);
    }
  }

  const tax = (payload['Tax'] ?? {}) as Record<string, unknown>;
  const codes = (tax['Codes'] ?? {}) as Record<string, Record<string, Record<string, string>>>;
  for (const direction of ['Sale', 'Purchase'] as const) {
    const set = codes[direction];
    if (!set) continue;
    const rendered = Object.values(set)
      .map(
        (c) =>
          `${c['TaxCode']} (${(Number(c['Rate'] ?? 0) * 100).toFixed(0)}%${c['IsDefault'] === 'yes' ? ', default' : ''})`,
      )
      .join(', ');
    console.log(`\n  ${direction} tax codes: ${rendered}`);
  }

  // 2. Rate-limit headroom.
  const rl = client.getRateLimit(target);
  if (rl) {
    console.log(`\n  Rate limit: ${rl.remainingMinute ?? '?'} left this minute, ${rl.remainingHour ?? '?'} this hour`);
    if (rl.resetMinuteAt) console.log(`    minute resets ${rl.resetMinuteAt}`);
    if (rl.resetHourAt) console.log(`    hour resets   ${rl.resetHourAt}`);
    if ((rl.remainingMinute ?? 100) < 50 || (rl.remainingHour ?? 1000) < 500) {
      console.log('    ⚠ Low headroom — WeFact bans the IP when the limit is breached.');
    }
  }

  // 3. A real business read, proving data endpoints work and not just settings.
  const debtors = await client.request({
    administration: target,
    controller: 'debtor',
    action: 'list',
    params: { limit: 1 },
  });
  const rows = (debtors['debtors'] ?? []) as Array<Record<string, string>>;
  console.log(`\n✓ debtor/list reachable — ${debtors['totalresults'] ?? 0} customer(s) in this administration`);
  if (rows.length > 0) {
    console.log(`    first: ${rows[0]?.['DebtorCode']} ${rows[0]?.['CompanyName'] ?? rows[0]?.['SurName'] ?? ''}`);
  } else {
    console.log('    (no customers yet — read tools will return empty results)');
  }

  console.log('\nAll checks passed.');
}

main().catch((err) => {
  reportFailure(err);
  process.exit(1);
});
