// The checks the dev server does not do, run before anything is pushed to the pod.
//
//   node scripts/check-dev-extension.mjs
//
// The dev server transpiles without type checking, so nothing in the ordinary loop notices a type
// error or an import of a module that is not there. Two passes here, and the second is the one
// that matters most, because it covers what the first cannot:
//
//   1. tsc over pkg/dev-extension. It sees only the 13 `.ts` files: `@rancher/shell` declares
//      `module '*.vue'`, so every import of a component resolves to a wildcard and none of the 19
//      `.vue` files enters the program. It also has to be told which type roots to use, because
//      the package's tsconfig names `cypress` and `jest`, neither of them installed, and an
//      unresolved entry in `types` is an options-level diagnostic that makes tsc skip semantic
//      checking entirely and report nothing else.
//
//      What that leaves unchecked, stated plainly rather than implied: **no type checking happens
//      inside a `.vue` file**. Every one of the 19 has a plain `<script>` block, so its contents
//      are JavaScript and carry no type annotations for a checker to verify; running vue-tsc over
//      them adds nothing but the resolution of their imports, which is what pass 2 does directly
//      and without needing the whole shell to typecheck. If a component is ever written with
//      `<script lang="ts">`, that stops being true and this needs vue-tsc.
//   2. a resolver pass over every relative import in every `.ts` and `.vue`. This is the one that
//      would have caught `pages/Workspaces.vue` importing `../nav`, a module deleted from the repo
//      and still present in the pod: green in the pod, and a build failure on any fresh checkout.
//      tsc cannot do it, because it never parses a `.vue` file.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
// Which package to check. Both seeds are real source that nothing else compiles - the barn
// build excludes them - so this is the only thing standing between a typo in either and a pod
// that boots into a broken dashboard.
const PACKAGES = {
  dev:  path.join(ROOT, 'pkg', 'barn', 'dev-extension', 'pkg', 'dev-extension'),
  base: path.join(ROOT, 'pkg', 'barn', 'base-extension', 'pkg', 'base'),
};

const WHICH = process.argv[2] || 'dev';
const PKG = PACKAGES[WHICH];

if (!PKG) {
  console.error(`no such package: ${ WHICH }. There is ${ Object.keys(PACKAGES).join(', ') }.`);
  process.exit(2);
}

/** Extensions an import can be written without, in the order a bundler would try them. */
const EXTENSIONS = ['', '.ts', '.vue', '.js', '.mjs', '.json', '/index.ts', '/index.js', '/index.vue'];

/** Every source file in the package, ignoring anything an install may have put under it. */
function sources(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue;
    }

    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      sources(full, acc);
    } else if (/\.(ts|vue|js)$/.test(entry.name)) {
      acc.push(full);
    }
  }

  return acc;
}

/**
 * Relative imports, from `import`, `export ... from`, `require()` and dynamic `import()`.
 *
 * Only relative ones: a bare specifier is a package, and whether it resolves is npm's business
 * rather than this file's.
 */
const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.[^'"]*)['"]/g;

/**
 * `./.shell/...`, which the shell's own build generates into the package as it runs.
 *
 * Absent from the repo on purpose, so it is the one relative specifier that is allowed not to
 * exist. Anything else that does not exist is the defect this pass is for.
 */
const GENERATED = /^\.\/\.shell\//;

/**
 * The code of a file, without the parts an import cannot really be in.
 *
 * Two of this package's modules hold shell scripts and a vue.config as template literals, and one
 * of those contains `require('./vue.config.orig.js')`, a path that is resolved inside a workspace
 * container rather than here. Scanning the raw text reports it as a missing module, which is a
 * false alarm of exactly the kind that gets a check switched off. For a `.vue`, only the script
 * block is scanned, so nothing in a template or a stylesheet can be mistaken for code.
 */
function code(file) {
  const source = fs.readFileSync(file, 'utf8');
  const script = file.endsWith('.vue')
    ? [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n')
    : source;

  return script
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``');
}

function unresolvedImports() {
  const problems = [];

  for (const file of sources(PKG)) {
    for (const [, specifier] of code(file).matchAll(IMPORT_PATTERN)) {
      if (GENERATED.test(specifier)) {
        continue;
      }

      const target = path.resolve(path.dirname(file), specifier);

      // A file, not merely a path that exists. `existsSync` is true for a directory, so an import
      // of `../components` resolved against the directory itself and was reported as fine when
      // nothing there could have been loaded.
      if (!EXTENSIONS.some((extension) => fs.statSync(target + extension, { throwIfNoEntry: false })?.isFile())) {
        problems.push(`${ path.relative(ROOT, file) }: imports '${ specifier }', which is not on disk`);
      }
    }
  }

  return problems;
}

/**
 * tsc, with the type roots it can actually resolve.
 *
 * `--types @types/node` replaces the package tsconfig's list rather than adding to it, which is
 * the point: the list there names `cypress` and `jest`, and one unresolvable name silences every
 * other diagnostic tsc would have produced.
 */
function typeErrors() {
  const tsc = path.join(ROOT, 'node_modules', '.bin', 'tsc');

  if (!fs.existsSync(tsc)) {
    return ['typescript is not installed in node_modules'];
  }

  let output = '';

  try {
    execFileSync(tsc, ['--noEmit', '-p', 'tsconfig.json', '--types', '@types/node'], {
      cwd: PKG, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    output = `${ error.stdout || '' }${ error.stderr || '' }`;
  }

  return output
    .split('\n')
    // Errors inside @rancher/shell itself are the toolchain's rather than this code's, and a
    // `.vue` or `@rancher/auto-import` specifier is one webpack resolves and tsc cannot.
    .filter((line) => /^[^\s].*error TS/.test(line))
    .filter((line) => !line.startsWith('../../node_modules/'))
    .filter((line) => !/Cannot find module '.*\.vue'/.test(line))
    .filter((line) => !/Cannot find module '@rancher\/auto-import'/.test(line));
}

const problems = [...unresolvedImports(), ...typeErrors()];

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

const files = sources(PKG);
const vue = files.filter((file) => file.endsWith('.vue')).length;

console.log(`checks passed: ${ files.length } files, every relative import resolves, types clean in the ${ files.length - vue } .ts files (the ${ vue } .vue files are JavaScript, so only their imports are checked)`);
