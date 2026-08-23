/**
 * build.mjs — bundle the CLI into one dependency-free file for npm.
 *
 * The controller half of this repo imports nothing but `node:` builtins, so the whole thing
 * collapses into a single ~100KB `dist/cli.mjs` that installs with an empty node_modules. It is
 * also what lets us stop shipping TypeScript: `bin` pointing at a `.ts` file only works on a Node
 * new enough to strip types by default, which would silently break every Node 22 user.
 *
 * `--target=node22` is the floor advertised in `engines`; keep the two in sync.
 */
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'dist', 'cli.mjs');

/*
 * The version is baked in rather than read at runtime. `dist/cli.mjs` sits at a different depth
 * relative to its package.json depending on whether it was installed globally, unpacked into an
 * npx cache, or run from the repo, so a walk-up-and-parse is a layout guess that fails quietly.
 * A `define` cannot be wrong. src/update-check.ts reads it through `typeof`, so a source checkout
 * (where esbuild never ran) still works and reports itself as a source build.
 */
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

mkdirSync(path.dirname(outfile), { recursive: true });

const result = await esbuild.build({
  entryPoints: [path.join(root, 'src', 'control-cli.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  define: { __CCC_VERSION__: JSON.stringify(version) },
  // Bare `node:` specifiers stay external automatically on platform=node; nothing else is imported.
  legalComments: 'none',
  logLevel: 'info',
  write: false, // we rewrite the shebang before it lands on disk
});

/*
 * esbuild carries the entry file's own shebang through to line 1, so a `banner` shebang would land
 * on line 2 and make the whole file a syntax error. Strip whatever came through and prepend the
 * plain form: the source uses `env -S node` for flags it no longer passes, and `-S` buys us nothing
 * here while being the one part of the line with a portability story.
 */
const body = result.outputFiles[0].text.replace(/^#![^\n]*\n/, '');
writeFileSync(outfile, `#!/usr/bin/env node\n${body}`);

chmodSync(outfile, 0o755); // npm sets the bit on install, but keep the built file runnable in-tree

const kb = (statSync(outfile).size / 1024).toFixed(1);
console.log(`built dist/cli.mjs (${kb} KB, v${version})`);
