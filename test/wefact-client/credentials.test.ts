import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_ADMINISTRATION_LABEL,
  WeFactClient,
  loadCredentialsFile,
  resolveCredentials,
  resolveCredentialsFilePath,
  type AdministrationCredentials,
} from '../../src/wefact-client.js';
import { withEnv } from '../helpers/env.js';

/**
 * Credential resolution.
 *
 * Real temporary files rather than a mocked `fs`: only two functions touch the
 * filesystem and both accept an explicit path, so real files are both simpler
 * and a more faithful test of the `existsSync` precedence they implement.
 */

const dirs: string[] = [];

function credentialsFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'wefact-test-'));
  dirs.push(dir);
  const path = join(dir, 'credentials.json');
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return path;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('loadCredentialsFile', () => {
  it('reads WeFact’s own api_key spelling', async () => {
    const path = credentialsFile({ acme: { api_key: 'key-a' } });
    const loaded = loadCredentialsFile(path);

    expect(loaded.found).toBe(true);
    expect(loaded.map.get('acme')).toEqual({ apiKey: 'key-a' });
  });

  it('also reads the camelCase spelling used by the sibling servers', async () => {
    // Whichever one we required, somebody would write the other.
    const path = credentialsFile({ acme: { apiKey: 'key-a' } });

    expect(loadCredentialsFile(path).map.get('acme')).toEqual({ apiKey: 'key-a' });
  });

  it('skips entries with no key at all rather than registering a broken one', async () => {
    const path = credentialsFile({ good: { api_key: 'k' }, broken: { note: 'oops' }, empty: null });
    const loaded = loadCredentialsFile(path);

    expect([...loaded.map.keys()]).toEqual(['good']);
  });

  it('reports a missing file without throwing', () => {
    const loaded = loadCredentialsFile('/nonexistent/credentials.json');

    expect(loaded.found).toBe(false);
    expect(loaded.map.size).toBe(0);
  });

  it('throws on malformed JSON rather than silently starting with no credentials', () => {
    const path = credentialsFile('{ not json');

    expect(() => loadCredentialsFile(path)).toThrow();
  });
});

describe('resolveCredentialsFilePath', () => {
  it('prefers an explicit path over everything', async () => {
    await withEnv({ WEFACT_CREDENTIALS_FILE: '/from/env.json' }, () => {
      expect(resolveCredentialsFilePath('/explicit.json')).toBe('/explicit.json');
    });
  });

  it('falls back to WEFACT_CREDENTIALS_FILE', async () => {
    await withEnv({ WEFACT_CREDENTIALS_FILE: '/from/env.json' }, () => {
      expect(resolveCredentialsFilePath()).toBe('/from/env.json');
    });
  });

  it('falls back to a relative credentials.json when nothing else is set', async () => {
    // The user-level ~/.wefact/credentials.json only wins if it exists, which
    // it does not on a clean machine.
    await withEnv({ WEFACT_CREDENTIALS_FILE: undefined }, () => {
      const path = resolveCredentialsFilePath();
      expect(path === 'credentials.json' || path.endsWith('.wefact/credentials.json')).toBe(true);
    });
  });
});

describe('resolveCredentials', () => {
  it('registers WEFACT_API_KEY under WEFACT_ADMINISTRATION', async () => {
    const resolved = await withEnv(
      { WEFACT_API_KEY: 'env-key', WEFACT_ADMINISTRATION: 'acme', WEFACT_CREDENTIALS_FILE: '/nonexistent.json' },
      () => resolveCredentials(),
    );

    expect(resolved.defaultAdministration).toBe('acme');
    expect(resolved.map.get('acme')).toEqual({ apiKey: 'env-key' });
  });

  it('falls back to the "default" label when no administration is named', async () => {
    const resolved = await withEnv(
      { WEFACT_API_KEY: 'env-key', WEFACT_ADMINISTRATION: undefined, WEFACT_CREDENTIALS_FILE: '/nonexistent.json' },
      () => resolveCredentials(),
    );

    expect(resolved.defaultAdministration).toBe(DEFAULT_ADMINISTRATION_LABEL);
    expect(resolved.map.get(DEFAULT_ADMINISTRATION_LABEL)?.apiKey).toBe('env-key');
  });

  it('lets a file entry win over an env key of the same label', async () => {
    // The file is the more deliberate configuration; an inherited env var must
    // not quietly redirect calls for a named administration.
    const path = credentialsFile({ acme: { api_key: 'file-key' } });
    const resolved = await withEnv(
      { WEFACT_API_KEY: 'env-key', WEFACT_ADMINISTRATION: 'acme', WEFACT_CREDENTIALS_FILE: path },
      () => resolveCredentials(),
    );

    expect(resolved.map.get('acme')?.apiKey).toBe('file-key');
  });

  it('keeps both when the env label differs from the file labels', async () => {
    const path = credentialsFile({ acme: { api_key: 'file-key' } });
    const resolved = await withEnv(
      { WEFACT_API_KEY: 'env-key', WEFACT_ADMINISTRATION: 'other', WEFACT_CREDENTIALS_FILE: path },
      () => resolveCredentials(),
    );

    expect(resolved.map.get('acme')?.apiKey).toBe('file-key');
    expect(resolved.map.get('other')?.apiKey).toBe('env-key');
    expect(resolved.defaultAdministration).toBe('other');
  });

  it('defaults to the first file entry when no env key is set', async () => {
    const path = credentialsFile({ first: { api_key: 'a' }, second: { api_key: 'b' } });
    const resolved = await withEnv(
      { WEFACT_API_KEY: undefined, WEFACT_ADMINISTRATION: undefined, WEFACT_CREDENTIALS_FILE: path },
      () => resolveCredentials(),
    );

    expect(resolved.defaultAdministration).toBe('first');
  });

  it('yields an empty picture when nothing is configured', async () => {
    const resolved = await withEnv(
      { WEFACT_API_KEY: undefined, WEFACT_ADMINISTRATION: undefined, WEFACT_CREDENTIALS_FILE: '/nonexistent.json' },
      () => resolveCredentials(),
    );

    expect(resolved.map.size).toBe(0);
    expect(resolved.defaultAdministration).toBe('');
  });
});

describe('client credential handling', () => {
  const map = (entries: Record<string, string>): Map<string, AdministrationCredentials> =>
    new Map(Object.entries(entries).map(([k, v]) => [k, { apiKey: v }]));

  it('exposes the configured administrations', () => {
    const client = new WeFactClient('a', map({ a: 'ka', b: 'kb' }));

    expect(client.listAdministrationNames()).toEqual(['a', 'b']);
    expect(client.credentialsCount).toBe(2);
    expect(client.defaultAdministrationName).toBe('a');
  });

  it('explains itself when no administration is set and none is passed', async () => {
    const client = new WeFactClient('', map({ a: 'ka' }));

    await expect(client.request({ controller: 'x', action: 'y' })).rejects.toThrow(/WEFACT_ADMINISTRATION is not set/);
  });

  it('reports added, updated and removed administrations on reload', () => {
    const client = new WeFactClient('a', map({ a: 'ka', b: 'kb', gone: 'kg' }));

    const diff = client.reloadCredentials(map({ a: 'ka', b: 'CHANGED', fresh: 'kf' }));

    expect(diff.added).toEqual(['fresh']);
    expect(diff.updated).toEqual(['b']);
    expect(diff.removed).toEqual(['gone']);
    expect(diff.total).toBe(3);
    expect(client.listAdministrationNames().sort()).toEqual(['a', 'b', 'fresh']);
  });

  it('reports no changes when the map is identical', () => {
    const client = new WeFactClient('a', map({ a: 'ka' }));

    const diff = client.reloadCredentials(map({ a: 'ka' }));

    expect(diff).toEqual({ added: [], updated: [], removed: [], total: 1 });
  });
});
