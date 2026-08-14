// The settings a fresh claude stops and asks for, answered in advance.
//
// A pod is a fresh machine every time, so without this the first thing the
// editor's terminal shows is a theme picker, then a "do you trust this folder"
// dialog, then a "Yes, I accept" for bypass permissions - three questions whose
// answers are the same every time and none of which the person opening the
// editor is being asked anything real by. What they should land in is a prompt,
// or a login.
//
// Only the flags are set here. The login itself is pulled from a Kubernetes
// Secret before the pane starts (see claude-credentials.mjs); what this file
// adds for it is the Stop hook that pushes a refreshed token back, so the pod
// that happens to refresh does not leave every other pod on a stale one.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = process.env.HOME || '/app/.home';
const CONFIG = path.join(HOME, '.claude.json');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');

// The directories a pane may start claude in, which is not the same list in
// every pod: the dev server's tabs land in its own tree, and a workspace's land
// in the checkout it cloned. shell.sh passes the pane's own directory; the
// default is the dev server pod's source and the app around it, which is what
// boot.sh's background run has no directory to pass.
const TRUSTED = (process.env.TRUST_DIRS || '/app/pkg/dev-extension:/app').split(':').filter(Boolean);

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Missing, or half-written by a claude that was killed. Either way the
    // defaults below are a better starting point than failing here.
    return {};
  }
}

// Written back only when something actually changed. claude rewrites this file
// as it runs, and this can be called while a session is attached, so the common
// case (everything already set) must not touch it at all.
function update(file, mutate) {
  const before = read(file);
  const after = JSON.parse(JSON.stringify(before));

  mutate(after);

  if (JSON.stringify(after) === JSON.stringify(before)) {
    return false;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${ JSON.stringify(after, null, 2) }\n`, { mode: 0o600 });

  return true;
}

function claudeVersion() {
  try {
    return execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim().split(' ')[0];
  } catch {
    return undefined;
  }
}

const changed = [
  update(CONFIG, (config) => {
    // Skips the whole first-run flow, the theme picker included.
    config.hasCompletedOnboarding = true;

    // claude re-runs onboarding when its version is newer than this, so it is
    // stamped with whatever is installed rather than hardcoded.
    const version = claudeVersion();

    if (version) {
      config.lastOnboardingVersion = version;
    }

    config.projects = config.projects || {};

    for (const dir of TRUSTED) {
      config.projects[dir] = {
        ...config.projects[dir],
        // The pod's tree came from this extension's own seed, so asking whether
        // it is trusted is asking the wrong side.
        hasTrustDialogAccepted:       true,
        hasCompletedProjectOnboarding: true,
      };
    }
  }),

  // The "Yes, I accept" dialog for --dangerously-skip-permissions, which the
  // pane's claude is always started with, and the hook that shares a refreshed
  // token with the other pods.
  update(SETTINGS, (settings) => {
    settings.skipDangerousModePermissionPrompt = true;

    // Stop, not a session end: it runs every time claude finishes a response,
    // which is the only moment this can be sure a refresh has already landed in
    // the file. The script itself does nothing when the local copy is not newer,
    // so running it that often costs a comparison.
    //
    // Merged rather than assigned, so a hook someone added by hand survives, and
    // matched on the command so this cannot accumulate copies of itself.
    const hooks = settings.hooks || (settings.hooks = {});
    const stop = hooks.Stop || (hooks.Stop = []);
    const command = 'node /seed/claude-credentials.mjs push';

    const already = stop.some((entry) => (entry.hooks || []).some((hook) => hook.command === command));

    if (!already) {
      stop.push({ hooks: [{ type: 'command', command }] });
    }
  }),
].some(Boolean);

console.log(changed ? '[claude] defaults written' : '[claude] defaults already set');
