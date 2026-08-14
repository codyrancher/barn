// The settings a fresh claude stops and asks for, answered in advance.
//
// A pod is a fresh machine every time, so without this the first thing the
// editor's terminal shows is a theme picker, then a "do you trust this folder"
// dialog, then a "Yes, I accept" for bypass permissions - three questions whose
// answers are the same every time and none of which the person opening the
// editor is being asked anything real by. What they should land in is a prompt,
// or a login.
//
// Only the flags are set. Credentials are not, and are not something a seeded
// file can carry: an unauthenticated claude says "Run /login", which is the
// other of the two states this is meant to produce.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = process.env.HOME || '/app/.home';
const CONFIG = path.join(HOME, '.claude.json');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');

// Directories a terminal is likely to start claude in: the extension source
// (where the pane opens) and the app around it.
const TRUSTED = ['/app/pkg/dev-extension', '/app'];

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
  // pane's claude is always started with.
  update(SETTINGS, (settings) => {
    settings.skipDangerousModePermissionPrompt = true;
  }),
].some(Boolean);

console.log(changed ? '[claude] defaults written' : '[claude] defaults already set');
