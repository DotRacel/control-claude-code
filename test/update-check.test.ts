/**
 * update-check.test.ts — the update-notice decision, without a registry or a home directory.
 *
 * The rules worth pinning: never nag a source checkout or an npx run, never nag on a cache miss,
 * survive a corrupted cache file, and stamp lastCheck even when the query failed (so an offline
 * box does not re-query on every launch).
 * Run: node --test test/update-check.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  installKind, registryBase, loadCheckState, saveCheckState, updateNotice, isStale,
  refreshInBackground, disabled, CHECK_INTERVAL_MS, VERSION,
} from '../src/update-check.ts';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-upd-')), 'update-check.json');

test('installKind: npx and source builds are never nagged', () => {
  assert.equal(installKind('/home/u/.npm/_npx/a1b2/node_modules/.bin/control-claude', '0.1.5'), 'npx');
  assert.equal(installKind('/usr/lib/node_modules/control-claude-code/dist/cli.mjs', '0.0.0-source'), 'source');
  assert.equal(installKind('/usr/lib/node_modules/control-claude-code/dist/cli.mjs', '0.1.5'), 'npm-global');
  assert.equal(installKind('/opt/somewhere/cli.mjs', '0.1.5'), 'unknown');
});

// A source checkout never ran esbuild, so the define never happened.
test('VERSION is the source placeholder when running from the repo', () => {
  assert.equal(VERSION, '0.0.0-source');
  assert.equal(installKind('/usr/lib/node_modules/x/dist/cli.mjs'), 'source');
});

test('updateNotice fires only on a real, newer, published version', () => {
  const cached = { lastCheck: 1, latest: '0.1.6' };
  const notice = updateNotice('0.1.5', cached, 'npm-global');
  assert.ok(notice && notice.includes('0.1.6'), 'names the new version');
  assert.ok(notice!.includes('npm i -g control-claude-code'), 'tells them how');

  assert.equal(updateNotice('0.1.6', cached, 'npm-global'), undefined, 'same version');
  assert.equal(updateNotice('0.1.7', cached, 'npm-global'), undefined, 'ahead of the registry');
  assert.equal(updateNotice('0.1.5', { lastCheck: 0 }, 'npm-global'), undefined, 'cache never filled');
  assert.equal(updateNotice('0.1.5', cached, 'source'), undefined, 'source checkout');
  assert.equal(updateNotice('0.1.5', cached, 'npx'), undefined, 'npx resolves latest anyway');
});

test('a prerelease is not offered as an update', () => {
  // compareVersion reads x.y.z only, so 0.2.0-rc.1 ties with 0.2.0 and loses to a released 0.2.0.
  assert.equal(updateNotice('0.2.0', { lastCheck: 1, latest: '0.2.0-rc.1' }, 'npm-global'), undefined);
});

test('cache round-trips, and a corrupt or absent file reads as empty', () => {
  const file = tmpFile();
  assert.deepEqual(loadCheckState(file), { lastCheck: 0 }, 'missing file');

  saveCheckState({ lastCheck: 1700000000000, latest: '0.1.6' }, file);
  assert.deepEqual(loadCheckState(file), { lastCheck: 1700000000000, latest: '0.1.6' });

  fs.writeFileSync(file, '{not json');
  assert.deepEqual(loadCheckState(file), { lastCheck: 0 }, 'corrupt file');

  fs.writeFileSync(file, JSON.stringify({ lastCheck: 'soon', latest: 'newest' }));
  assert.deepEqual(loadCheckState(file), { lastCheck: 0 }, 'garbage field types are dropped');
});

test('staleness gates the query to once a day', () => {
  const now = 1_700_000_000_000;
  assert.equal(isStale({ lastCheck: 0 }, now), true, 'never checked');
  assert.equal(isStale({ lastCheck: now - 1000 }, now), false, 'just checked');
  assert.equal(isStale({ lastCheck: now - CHECK_INTERVAL_MS }, now), true, 'exactly due');
});

test('registryBase honours npm config, without shelling out to npm', () => {
  assert.equal(registryBase({}), 'https://registry.npmjs.org');
  assert.equal(registryBase({ npm_config_registry: 'https://r.example.com/' }), 'https://r.example.com');
  assert.equal(registryBase({ NPM_CONFIG_REGISTRY: ' https://r2.example.com ' }), 'https://r2.example.com');
});

test('the background refresh writes what the registry said', async () => {
  const file = tmpFile();
  const now = 1_700_000_000_000;
  await refreshInBackground({ file, now, kind: 'npm-global', query: async () => '0.2.0' });
  assert.deepEqual(loadCheckState(file), { lastCheck: now, latest: '0.2.0' });
});

// An offline box must not re-query on every single launch, so a failed query still stamps the
// clock — and must not wipe the last version we did learn.
test('a failed query stamps the clock and keeps the previous answer', async () => {
  const file = tmpFile();
  saveCheckState({ lastCheck: 1, latest: '0.2.0' }, file);
  await refreshInBackground({ file, now: 1_700_000_000_000, kind: 'npm-global', query: async () => null });
  assert.deepEqual(loadCheckState(file), { lastCheck: 1_700_000_000_000, latest: '0.2.0' });
});

test('the refresh is skipped when it would tell us nothing, or nothing new', async () => {
  const now = 1_700_000_000_000;
  let queried = 0;
  const query = async () => { queried++; return '0.2.0'; };

  const fresh = tmpFile();
  saveCheckState({ lastCheck: now - 1000 }, fresh); // checked a second ago
  await refreshInBackground({ file: fresh, now, kind: 'npm-global', query });
  assert.equal(queried, 0, 'cache still fresh');

  for (const kind of ['source', 'npx']) {
    await refreshInBackground({ file: tmpFile(), now, kind: kind as any, query });
  }
  assert.equal(queried, 0, 'source and npx never reach the registry');
});

test('CCC_NO_UPDATE_CHECK silences the notice AND the network call', async () => {
  assert.equal(disabled({ CCC_NO_UPDATE_CHECK: '1' }), true);
  assert.equal(disabled({ CCC_NO_UPDATE_CHECK: 'true' }), true);
  assert.equal(disabled({ CCC_NO_UPDATE_CHECK: '0' }), false);
  assert.equal(disabled({}), false);

  const cached = { lastCheck: 1, latest: '9.9.9' };
  assert.equal(updateNotice('0.1.5', cached, 'npm-global', { CCC_NO_UPDATE_CHECK: '1' }), undefined);
  assert.ok(updateNotice('0.1.5', cached, 'npm-global', {}), 'still fires without the opt-out');

  let queried = 0;
  await refreshInBackground({
    file: tmpFile(), now: 1_700_000_000_000, kind: 'npm-global',
    query: async () => { queried++; return '9.9.9'; },
    env: { CCC_NO_UPDATE_CHECK: '1' },
  });
  assert.equal(queried, 0, 'opting out means no traffic, not just no message');
});
