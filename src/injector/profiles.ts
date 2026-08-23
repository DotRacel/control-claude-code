/**
 * profiles.ts — version-profiled injection surface.
 *
 * The locators in anchors.ts absorb a claude release's minified-NAME churn at runtime, but not a
 * change to a guard's CODE SHAPE (e.g. 2.1.238 merging two trusted-device functions into one).
 * A PROFILE bundles the gate set that matches a version range; `selectProfile` picks one from the
 * claude version detected at launch.
 *
 * Selection is DELIBERATELY OPTIMISTIC and never throws: an unknown-newer claude gets the newest
 * profile, an unknown-older claude gets the oldest, and either way the locator run that follows
 * reports exactly which gate (if any) failed to match — a bad guess degrades to a loud, specific
 * miss, not a silent wrong-rebind. So we always try to inject rather than refuse on the version
 * number alone. (This matches the product decision: never block launch on version.)
 *
 * When a future release drifts a gate, the CI matrix (injection-compat) goes red on that version;
 * the fix is to add a gate variant in anchors.ts and a new profile entry here.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  type GateSpec,
  type InteractiveGateSpec,
  headlessGates,
  GATE_DISPATCH_TRUST_LEGACY,
  GATE_DISPATCH_TRUST_PREFLIGHT,
  INTERACTIVE_GATES,
} from './anchors.ts';

export interface InjectionProfile {
  /** Stable id for logs/reports. */
  id: string;
  /** Inclusive minimum claude version this profile targets (semver "x.y.z"). */
  since: string;
  /** Highest version actually measured green (for exact-vs-optimistic logging). Optional. */
  verifiedThrough?: string;
  /** Headless `remote-control` gates. */
  gates: GateSpec[];
  /** Interactive `/rc` gates. */
  interactiveGates: InteractiveGateSpec[];
}

/**
 * Profiles, ORDER-INDEPENDENT (selectProfile sorts by `since`). Add newest-drift profiles here.
 *
 * The interactive `/rc` gates and the child `--sdk-url` locator are stable across every version
 * measured so far, so both profiles share `INTERACTIVE_GATES`; only `dispatch.trust` differs.
 */
export const PROFILES: InjectionProfile[] = [
  {
    id: 'legacy',
    since: '2.1.229',
    verifiedThrough: '2.1.237',
    gates: headlessGates(GATE_DISPATCH_TRUST_LEGACY),
    interactiveGates: INTERACTIVE_GATES,
  },
  {
    id: 'preflight',
    since: '2.1.238',
    verifiedThrough: '2.1.238',
    gates: headlessGates(GATE_DISPATCH_TRUST_PREFLIGHT),
    interactiveGates: INTERACTIVE_GATES,
  },
];

/** Extract [major, minor, patch] from "2.1.238", "2.1.238 (Claude Code)", "v2.1.238", etc. */
export function parseVersion(s: string): [number, number, number] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s || '');
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Compare two version strings numerically. -1 if a<b, 0 if equal, 1 if a>b. */
export function compareVersion(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (va[i] < vb[i]) return -1;
    if (va[i] > vb[i]) return 1;
  }
  return 0;
}

/** How confident the selection is — affects log wording only, not which profile is chosen. */
export type SelectNote = 'exact' | 'optimistic-newer' | 'optimistic-older';

/**
 * Pick the profile for a detected version. Optimistic and total: version at/above a profile's
 * `since` picks the highest such profile; a version below every `since` picks the oldest. Never
 * throws.
 */
export function selectProfile(version: string): { profile: InjectionProfile; note: SelectNote } {
  const sorted = [...PROFILES].sort((a, b) => compareVersion(a.since, b.since));
  let chosen = sorted[0];
  for (const p of sorted) {
    if (compareVersion(version, p.since) >= 0) chosen = p;
  }
  let note: SelectNote;
  if (compareVersion(version, chosen.since) < 0) {
    note = 'optimistic-older'; // below the oldest profile's floor
  } else if (chosen.verifiedThrough && compareVersion(version, chosen.verifiedThrough) > 0) {
    note = 'optimistic-newer'; // past what we've measured for this profile
  } else {
    note = 'exact';
  }
  return { profile: chosen, note };
}

/** The newest profile by `since` — the optimistic fallback when the version can't be detected. */
export function newestProfile(): InjectionProfile {
  return [...PROFILES].sort((a, b) => compareVersion(a.since, b.since))[PROFILES.length - 1];
}

/** A bare semver name, as the native installer names a version directory: "2.1.241". */
const BARE_VERSION = /^v?(\d+\.\d+\.\d+)$/;

/** Resolve `claudeBin` to a path the way execFile would — a bare name is looked up on PATH. */
function resolveBinPath(claudeBin: string): string | null {
  try {
    if (claudeBin.includes('/') || claudeBin.includes(path.sep)) {
      const abs = path.resolve(claudeBin);
      return fs.statSync(abs).isFile() ? abs : null;
    }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      const abs = path.join(dir, claudeBin);
      try {
        if (!fs.statSync(abs).isFile()) continue;
        fs.accessSync(abs, fs.constants.X_OK);
        return abs;
      } catch { /* not this PATH entry */ }
    }
  } catch { /* unreadable PATH entry / bad bin */ }
  return null;
}

/**
 * Read the version off the INSTALL LAYOUT, with no process spawn.
 *
 * `claude --version` costs a full launch of a ~340MB Bun binary (measured 120-270ms warm, worse
 * on a cold page cache) purely to print a string the filesystem already spells out:
 *   - native installer: `bin/claude` → `share/claude/versions/<x.y.z>`  (basename IS the version)
 *   - npm global:       `bin/claude` → `lib/node_modules/@anthropic-ai/claude-code/cli.js`
 *                       (its package.json carries the version)
 * Both are checked strictly — a basename that is not bare semver, or a package.json that is not
 * claude-code's, returns null so the caller falls back to the authoritative `--version` probe.
 */
export function versionFromInstall(claudeBin: string): string | null {
  const bin = resolveBinPath(claudeBin);
  if (!bin) return null;
  let real: string;
  try { real = fs.realpathSync(bin); } catch { return null; }

  const m = BARE_VERSION.exec(path.basename(real));
  if (m) return m[1];

  // npm layout: package.json sits beside cli.js (one level up covers a bin/ subdir).
  let dir = path.dirname(real);
  for (let i = 0; i < 2; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (/claude-code/.test(String(pkg?.name ?? '')) && /^\d+\.\d+\.\d+/.test(String(pkg?.version ?? ''))) {
        return String(pkg.version);
      }
    } catch { /* no/unreadable package.json here */ }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Return the claude version string, or null if it can't be determined. Never throws — a probe
 * failure just means "undetected".
 *
 * Tries the free filesystem read first (`versionFromInstall`) and only spawns
 * `<claudeBin> --version` for an install layout we don't recognise.
 */
export function detectClaudeVersion(claudeBin: string): Promise<string | null> {
  const fromInstall = versionFromInstall(claudeBin);
  if (fromInstall) return Promise.resolve(fromInstall);
  return new Promise((resolve) => {
    execFile(claudeBin, ['--version'], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      const out = String(stdout || '').trim();
      resolve(/\d+\.\d+\.\d+/.test(out) ? out : null);
    });
  });
}

export interface ResolvedProfile {
  profile: InjectionProfile;
  /** Raw detected version string, or null if the probe failed. */
  version: string | null;
  /** 'undetected' when the version probe failed (fell back to the newest profile). */
  note: SelectNote | 'undetected';
}

/**
 * Detect the version of `claudeBin` and resolve the profile to inject with. On probe failure,
 * falls back to the newest profile (optimistic) with note 'undetected'.
 */
export async function resolveProfile(claudeBin: string): Promise<ResolvedProfile> {
  const version = await detectClaudeVersion(claudeBin);
  if (version == null) {
    return { profile: newestProfile(), version: null, note: 'undetected' };
  }
  const { profile, note } = selectProfile(version);
  return { profile, version, note };
}
