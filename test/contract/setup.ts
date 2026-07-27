import 'dotenv/config';

/**
 * Guard for the contract project, which calls the live WeFact API.
 *
 * WeFact requires the caller's public IP to be whitelisted. CI runners have
 * dynamic egress addresses, so a contract test on a runner does not merely fail
 * — every attempt counts against the per-IP daily cap on failed authentication
 * attempts, from an address nobody can whitelist.
 *
 * These checks run at module load rather than in a `beforeAll`, and throw
 * rather than skipping. Both details matter:
 *
 *   - A `beforeAll` never runs if the suite is skipped, so a guard there can be
 *     bypassed by the very condition it is meant to catch.
 *   - A skip is invisible. Someone could add `WEFACT_CONTRACT=1` to a workflow,
 *     see green, and believe the live API was being checked when nothing ran.
 *     Failing loudly makes the mistake impossible to miss.
 *
 * Running `npm run test:contract` is always deliberate, so a refusal here is
 * information the caller wants, not friction.
 */

if (process.env['GITHUB_ACTIONS'] || process.env['CI']) {
  throw new Error(
    'Contract tests call the live WeFact API and require a whitelisted source IP. ' +
      'CI runners have dynamic egress IPs, so running them here would fail AND consume the per-IP ' +
      'daily failed-authentication cap. Run them locally instead: npm run test:contract',
  );
}

if (process.env['WEFACT_CONTRACT'] !== '1') {
  throw new Error('Contract tests are opt-in because they spend live API budget. Run them with: npm run test:contract');
}

if (!process.env['WEFACT_API_KEY'] && !process.env['WEFACT_CREDENTIALS_FILE']) {
  throw new Error(
    'Contract tests need real credentials. Set WEFACT_API_KEY (or WEFACT_CREDENTIALS_FILE) and make sure ' +
      "this machine's public IP is whitelisted under Instellingen → API. Run `npm run whoami` to check.",
  );
}

/**
 * Kept for the `describe.runIf` guards as a second layer: if the throws above
 * were ever softened, the suites still would not silently call the live API.
 */
export const CONTRACT_ENABLED = true;
