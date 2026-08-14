// Push the generated seed into the running pod's ConfigMap.
//
// The pod runs its scripts out of /seed, which is a ConfigMap mount, and that ConfigMap is
// written by the barn extension from the file this script reads. So editing anything in
// dev-extension/pod/ has three steps, and skipping the last one is the trap:
//
//   1. edit dev-extension/pod/<file>
//   2. node scripts/gen-dev-extension-seed.mjs
//   3. node scripts/apply-dev-extension-seed.mjs   <- this
//
// Without the third, the change reaches a fresh pod and never the running one. Patching the
// ConfigMap by hand instead of from the generated seed is worse than not doing it: the two then
// disagree, and the next time anyone loads Rancher the extension writes its own copy back over
// yours, silently.
//
// The kubelet syncs a ConfigMap volume on its own schedule, up to about a minute, so a change
// is not in /seed the instant this exits. Existing tmux sessions keep the script they started
// with; a new session picks up the new one.
//
//   node scripts/apply-dev-extension-seed.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OWNER = path.join(here, '..', 'pkg', 'barn', 'extensions.ts');
const SEED = path.join(here, '..', 'pkg', 'barn', 'dev-extension-seed.generated.ts');

const NAMESPACE = 'barn';
const NAME = 'barn-dev-extension';

/** Read `export const NAME = 'value';` out of a TypeScript source, as the generator does. */
function tsConstant(file, name) {
  const match = fs.readFileSync(file, 'utf8').match(new RegExp(`export const ${ name } = '([^']*)';`));

  if (!match) {
    throw new Error(`could not find "export const ${ name }" in ${ path.basename(file) }`);
  }

  return match[1];
}

// The generated file is a header and then JSON.stringify's output, so the seed is parsed rather
// than re-read from the tree. Reading the tree again would be a second implementation of which
// files are in the seed, and the two would eventually disagree.
const source = fs.readFileSync(SEED, 'utf8');
const files = JSON.parse(source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1));

const separator = tsConstant(OWNER, 'PATH_SEPARATOR');
const data = {};

for (const [file, contents] of Object.entries(files)) {
  data[file.split('/').join(separator)] = contents;
}

const body = {
  apiVersion: 'v1',
  kind:       'ConfigMap',
  metadata:   { namespace: NAMESPACE, name: NAME },
  data,
};

const tmp = path.join(os.tmpdir(), `dev-extension-seed-${ process.pid }.json`);

fs.writeFileSync(tmp, JSON.stringify(body));

try {
  // replace, not apply: this is the same whole-object PUT the extension makes, so a file
  // removed from the seed is removed from /seed rather than left behind by a merge.
  execFileSync('kubectl', ['replace', '-f', tmp], { stdio: 'inherit' });
} catch {
  execFileSync('kubectl', ['create', '-f', tmp], { stdio: 'inherit' });
} finally {
  fs.unlinkSync(tmp);
}

console.log(`seed: ${ Object.keys(data).length } keys -> configmap/${ NAME } in ${ NAMESPACE }`);
console.log('the kubelet syncs /seed within about a minute; new terminal sessions pick it up.');
