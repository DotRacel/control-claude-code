/**
 * update-check.ts — tell the user when a newer `control-claude-code` is on npm.
 *
 * The constraint that shapes all of this: in interactive mode claude's TUI takes the terminal
 * with `stdio: 'inherit'` and repaints it. Anything we print after launch is either overwritten
 * or corrupts the frame, so the notice has to be on screen BEFORE claude starts — and blocking
 * a launch on a registry round-trip is not a trade we are willing to make.
 *
 * So the check is one turn behind, deliberately:
 *
 *   launch N   → print what the cache already knows (a file read, no network) → claude starts
 *              → refresh the cache in the background, whenever it lands
 *   launch N+1 → print that
 *
 * A user who never updates sees the notice on every launch after the first, which is the point.
 * The one-launch delay only ever delays the FIRST sighting of a release, and it buys a launch
 * path with no added latency and no timeout to tune.
 *
 * Everything here fails silent. A missing cache, a private registry, an air-gapped box, a
 * corrupted JSON file — none of it is the user's problem, and none of it may cost them a launch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './cli-auth.ts';
// The injector's semver helper, reused rather than reimplemented: comparing "0.1.5" to "0.1.6" is
// the same problem whether the version came from claude or from us. Importing it costs no bundle
// size (control-cli already pulls profiles.ts in through gate-rebind) and runs no code at import.
import { compareVersion } from './injector/profiles.ts';

/**
 * Our own version, substituted at build time by scripts/build.mjs (`define`).
 *
 * Read from the compiled constant rather than a package.json lookup at runtime: `dist/cli.mjs` is
 * a bundle whose path relative to its package.json differs between an npm install, a `npx` cache
 * and a source checkout, so a walk-up-and-parse would be exactly the kind of layout guess that
 * silently returns the wrong answer. `declare` disappears under Node's type stripping, so in a
 * source checkout the identifier genuinely does not exist — hence `typeof`, which is the one form
 * that does not throw on an undeclared name.
 */
declare const __CCC_VERSION__: string | undefined;
export const VERSION: string = typeof __CCC_VERSION__ === 'string' ? __CCC_VERSION__ : '0.0.0-source';

export const PACKAGE_NAME = 'control-claude-code';
/** Cache lives beside the config but NOT inside it — config.json holds tokens and is 0600, and
 *  loadConfig() drops unknown keys, so a field added there would vanish on the next save. */
export const CHECK_FILE = path.join(CONFIG_DIR, 'update-check.json');
/** How stale the cache may get before we refresh it. claude ships most days; we do not. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

export interface CheckState {
  /** Epoch ms of the last completed registry query (successful or not). */
  lastCheck: number;
  /** Newest version the registry reported, if a query ever succeeded. */
  latest?: string;
}

/** How this copy of the CLI got onto the machine — decides whether an update notice makes sense. */
export type InstallKind = 'npm-global' | 'npx' | 'source' | 'unknown';

/** Opt-out, for CI and for anyone whose box should make no unbidden network calls. Suppresses both
 *  the notice and the query — a user who turned this off should not see traffic to a registry. */
export const disabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.CCC_NO_UPDATE_CHECK === '1' || env.CCC_NO_UPDATE_CHECK === 'true';

/**
 * Classify the install. Only `npm-global` and `unknown` are worth nagging:
 *  - `source` is a checkout — the user updates it with git, and VERSION is a placeholder anyway.
 *  - `npx` resolves the latest published version on every run, so there is nothing to update; its
 *    cache directory is the giveaway (`…/_npx/<hash>/node_modules/…`).
 */
export function installKind(selfPath: string = process.argv[1] || '', version: string = VERSION): InstallKind {
  if (version === '0.0.0-source') return 'source';
  const p = selfPath.replace(/\\/g, '/');
  if (p.includes('/_npx/')) return 'npx';
  if (p.includes('/node_modules/')) return 'npm-global';
  return 'unknown';
}

/** Registry base URL, honouring npm's own env config. Deliberately does not shell out to `npm
 *  config get registry`: that is a ~200ms node boot, and this file exists to not cost a launch. */
export function registryBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.npm_config_registry || env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org';
  return raw.trim().replace(/\/+$/, '');
}

export function loadCheckState(file: string = CHECK_FILE): CheckState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const lastCheck = Number(parsed?.lastCheck);
    const latest = typeof parsed?.latest === 'string' && /^\d+\.\d+\.\d+/.test(parsed.latest)
      ? parsed.latest as string
      : undefined;
    // Omit `latest` rather than setting it undefined, so a state read back from a garbage file is
    // indistinguishable from one read from no file at all.
    return {
      lastCheck: Number.isFinite(lastCheck) && lastCheck > 0 ? lastCheck : 0,
      ...(latest ? { latest } : {}),
    };
  } catch {
    return { lastCheck: 0 };
  }
}

export function saveCheckState(state: CheckState, file: string = CHECK_FILE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state) + '\n');
  } catch { /* unwritable config dir — the check is a nicety, not a feature */ }
}

/**
 * The notice to print, or undefined when there is nothing to say. Pure, so the decision is
 * testable without a registry or a home directory.
 */
export function updateNotice(
  current: string,
  cached: CheckState,
  kind: InstallKind = installKind(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (disabled(env)) return undefined;
  if (kind === 'source' || kind === 'npx') return undefined;
  if (!cached.latest) return undefined;
  if (compareVersion(cached.latest, current) <= 0) return undefined;
  // Dim, single line, above whatever comes next: visible on a scan, never in the way. The install
  // command is the one from the README, so copy-paste works even if the user forgot how they got it.
  return `\x1b[2m  control-claude-code ${current} → \x1b[0m\x1b[1m${cached.latest}\x1b[0m\x1b[2m 可用：npm i -g ${PACKAGE_NAME}\x1b[0m`;
}

/** Ask the registry for the published `latest`. Returns null on any failure, including timeout. */
export async function fetchLatest(
  pkg: string = PACKAGE_NAME,
  base: string = registryBase(),
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<string | null> {
  try {
    // The `/latest` document is a few hundred bytes; the full packument is megabytes.
    const res = await fetch(`${base}/${encodeURIComponent(pkg)}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    const v = body?.version;
    return typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null; // offline, DNS, private registry, 404, malformed JSON — all the same to us
  }
}

/** Whether the cache is stale enough to re-query. */
export const isStale = (state: CheckState, now: number, interval = CHECK_INTERVAL_MS): boolean =>
  now - state.lastCheck >= interval;

/**
 * Refresh the cache without holding anything up. The returned promise exists for tests only —
 * main() deliberately does not await it: it runs alongside claude and its result is read by the
 * NEXT launch. If claude exits first the process.exit() in runInteractive/runHeadless drops the
 * in-flight request, which costs nothing — the cache keeps its old lastCheck and the next launch
 * tries again.
 */
export function refreshInBackground(
  opts: {
    file?: string; now?: number; kind?: InstallKind;
    query?: () => Promise<string | null>; env?: NodeJS.ProcessEnv;
  } = {},
): Promise<void> {
  const file = opts.file ?? CHECK_FILE;
  const now = opts.now ?? Date.now();
  const kind = opts.kind ?? installKind();
  if (disabled(opts.env ?? process.env)) return Promise.resolve();
  if (kind === 'source' || kind === 'npx') return Promise.resolve(); // nothing a notice could tell them
  if (!isStale(loadCheckState(file), now)) return Promise.resolve();
  return (opts.query ?? fetchLatest)().then((latest) => {
    // Stamp lastCheck even on failure: a box that cannot reach the registry must not retry on
    // every single launch.
    const prev = loadCheckState(file);
    saveCheckState({ lastCheck: now, latest: latest ?? prev.latest }, file);
  });
}
