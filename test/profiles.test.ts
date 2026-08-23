/**
 * profiles.test.ts — version → injection-profile selection.
 *
 * Pure-function coverage for the version-profiled injection surface (src/injector/profiles.ts):
 * version parsing/compare, and that selectProfile picks the right gate set and note across the
 * exact / optimistic-newer / optimistic-older cases. No claude, no inspector — just the logic
 * that decides which gates get injected.
 *
 * Run: node --test test/profiles.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseVersion, compareVersion, selectProfile, newestProfile, PROFILES, versionFromInstall, detectClaudeVersion } from '../src/injector/profiles.ts';

test('parseVersion extracts x.y.z from various shapes', () => {
  assert.deepEqual(parseVersion('2.1.238'), [2, 1, 238]);
  assert.deepEqual(parseVersion('2.1.238 (Claude Code)'), [2, 1, 238]);
  assert.deepEqual(parseVersion('v2.1.238'), [2, 1, 238]);
  assert.deepEqual(parseVersion('claude 2.1.229\n'), [2, 1, 229]);
  // No version → [0,0,0] (never throws; selection degrades to oldest profile).
  assert.deepEqual(parseVersion('nonsense'), [0, 0, 0]);
  assert.deepEqual(parseVersion(''), [0, 0, 0]);
});

test('compareVersion orders numerically, not lexically', () => {
  assert.equal(compareVersion('2.1.238', '2.1.237'), 1);
  assert.equal(compareVersion('2.1.237', '2.1.238'), -1);
  assert.equal(compareVersion('2.1.238', '2.1.238'), 0);
  // Patch is compared as a number: 100 > 99, not "100" < "99".
  assert.equal(compareVersion('2.1.100', '2.1.99'), 1);
  assert.equal(compareVersion('2.2.0', '2.1.999'), 1);
});

test('selectProfile: exact matches within each profile range', () => {
  for (const v of ['2.1.229', '2.1.232', '2.1.234', '2.1.237']) {
    const { profile, note } = selectProfile(v);
    assert.equal(profile.id, 'legacy', `${v} → legacy`);
    assert.equal(note, 'exact');
    // legacy uses the two-function trusted-device gate (aliases W & G).
    const trust = profile.gates.find((g) => g.id === 'dispatch.trust')!;
    assert.deepEqual(Object.keys(trust.aliases).sort(), ['G', 'W']);
  }
  {
    const { profile, note } = selectProfile('2.1.238');
    assert.equal(profile.id, 'preflight');
    assert.equal(note, 'exact');
    // preflight uses the single-function gate (alias Z)…
    const trust = profile.gates.find((g) => g.id === 'dispatch.trust')!;
    assert.deepEqual(Object.keys(trust.aliases), ['Z']);
    // …but still the one-token-getter tokenurl gate.
    const tokenUrl = profile.gates.find((g) => g.id === 'bridgeMain.tokenurl')!;
    assert.deepEqual(Object.keys(tokenUrl.aliases).sort(), ['M', 'P']);
  }
  for (const v of ['2.1.239', '2.1.241']) {
    const { profile, note } = selectProfile(v);
    assert.equal(profile.id, 'async-token', `${v} → async-token`);
    assert.equal(note, 'exact');
    // async-token keeps preflight's trust gate…
    const trust = profile.gates.find((g) => g.id === 'dispatch.trust')!;
    assert.deepEqual(Object.keys(trust.aliases), ['Z']);
    // …and swaps in the tokenurl gate that also rebinds getBridgeAccessTokenAsync.
    const tokenUrl = profile.gates.find((g) => g.id === 'bridgeMain.tokenurl')!;
    assert.deepEqual(Object.keys(tokenUrl.aliases).sort(), ['A', 'M', 'P', 'U']);
    assert.equal(tokenUrl.rebinds.length, 3);
  }
});

test('the profile boundaries are contiguous — no version falls between two profiles', () => {
  // Every profile's `since` must be reachable: sorted by since, each range is [since, next.since).
  const sorted = [...PROFILES].sort((a, b) => compareVersion(a.since, b.since));
  for (const p of sorted) {
    assert.equal(selectProfile(p.since).profile.id, p.id, `${p.since} must select ${p.id}`);
    // verifiedThrough, where set, must still land inside the profile it belongs to.
    if (p.verifiedThrough) {
      assert.equal(selectProfile(p.verifiedThrough).profile.id, p.id, `${p.verifiedThrough} → ${p.id}`);
      assert.ok(compareVersion(p.verifiedThrough, p.since) >= 0, `${p.id}: verifiedThrough >= since`);
    }
  }
});

test('selectProfile: optimistic-newer picks the newest profile for unknown-newer versions', () => {
  const { profile, note } = selectProfile('2.1.999');
  assert.equal(profile.id, 'async-token');
  assert.equal(note, 'optimistic-newer');
  assert.equal(profile.id, newestProfile().id);
});

test('selectProfile: a claude-code version string with suffix still resolves', () => {
  const { profile } = selectProfile('2.1.238 (Claude Code)');
  assert.equal(profile.id, 'preflight');
});

test('selectProfile: optimistic-older falls back to the oldest profile below the floor', () => {
  const oldest = [...PROFILES].sort((a, b) => compareVersion(a.since, b.since))[0];
  const { profile, note } = selectProfile('2.1.100');
  assert.equal(profile.id, oldest.id);
  assert.equal(profile.id, 'legacy');
  assert.equal(note, 'optimistic-older');
});

test('selectProfile never throws on garbage input', () => {
  for (const v of ['', 'nonsense', 'x.y.z']) {
    const { profile } = selectProfile(v);
    // [0,0,0] is below every floor → oldest profile, no throw.
    assert.ok(profile.id.length > 0);
  }
});

test('every profile carries the full headless + interactive gate sets', () => {
  for (const p of PROFILES) {
    assert.equal(p.gates.length, 7, `${p.id} has 7 headless gates`);
    assert.ok(p.interactiveGates.length >= 7, `${p.id} has interactive gates`);
    // dispatch.trust is present exactly once in every profile.
    assert.equal(p.gates.filter((g) => g.id === 'dispatch.trust').length, 1);
  }
});

// ── version detection off the install layout (no `claude --version` spawn) ────────────────
//
// The probe used to shell out to a ~340MB Bun binary on every launch, on the critical path.
// versionFromInstall reads what the filesystem already spells out; these fix the two layouts
// it recognises AND the strictness that sends anything else back to the `--version` fallback.

/** Build a throwaway install tree under a temp dir; returns its root. */
function makeInstall(build: (root: string) => void): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-install-'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  build(root);
  return root;
}

test('versionFromInstall reads the native installer layout (bin/claude → versions/x.y.z)', () => {
  const root = makeInstall((r) => {
    fs.mkdirSync(path.join(r, 'share/claude/versions'), { recursive: true });
    fs.writeFileSync(path.join(r, 'share/claude/versions/2.1.241'), '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync(path.join(r, 'share/claude/versions/2.1.241'), path.join(r, 'bin/claude'));
  });
  try {
    assert.equal(versionFromInstall(path.join(root, 'bin/claude')), '2.1.241');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('versionFromInstall reads the npm global layout (package.json beside cli.js)', () => {
  const root = makeInstall((r) => {
    const pkgDir = path.join(r, 'lib/node_modules/@anthropic-ai/claude-code');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.237' }));
    fs.symlinkSync(path.join(pkgDir, 'cli.js'), path.join(r, 'bin/claude'));
  });
  try {
    assert.equal(versionFromInstall(path.join(root, 'bin/claude')), '2.1.237');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('versionFromInstall refuses to guess from an unrecognised layout', () => {
  const root = makeInstall((r) => {
    // A plain binary in a dir named nothing like a version, and a package.json for a DIFFERENT
    // package — neither may be read as claude's version.
    fs.writeFileSync(path.join(r, 'bin/claude'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(r, 'bin/package.json'), JSON.stringify({ name: 'some-wrapper', version: '9.9.9' }));
  });
  try {
    assert.equal(versionFromInstall(path.join(root, 'bin/claude')), null);
    assert.equal(versionFromInstall(path.join(root, 'bin/does-not-exist')), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('detectClaudeVersion answers from the layout without executing the binary', async () => {
  // The "binary" is a text file with no exec bit — spawning it could only fail. Getting the
  // version back therefore proves the filesystem path answered, i.e. no launch on the hot path.
  const root = makeInstall((r) => {
    fs.mkdirSync(path.join(r, 'share/claude/versions'), { recursive: true });
    fs.writeFileSync(path.join(r, 'share/claude/versions/2.1.230'), 'not a program', { mode: 0o644 });
    fs.symlinkSync(path.join(r, 'share/claude/versions/2.1.230'), path.join(r, 'bin/claude'));
  });
  try {
    assert.equal(await detectClaudeVersion(path.join(root, 'bin/claude')), '2.1.230');
    // …and it feeds selection the same way a `--version` string would.
    assert.equal(selectProfile('2.1.230').profile.id, 'legacy');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('detectClaudeVersion falls back to the probe, and stays null when it cannot run', async () => {
  const root = makeInstall((r) => {
    fs.writeFileSync(path.join(r, 'bin/claude'), 'not a program', { mode: 0o644 });
  });
  try {
    // Unrecognised layout → the `--version` fallback runs → non-executable file → null, no throw.
    assert.equal(await detectClaudeVersion(path.join(root, 'bin/claude')), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
