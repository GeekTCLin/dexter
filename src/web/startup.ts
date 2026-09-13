import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** web/ SPA directory, resolved from this module so it works from any cwd. */
const WEB_DIR = fileURLToPath(new URL('../../web', import.meta.url));
const WEB_SRC_DIR = join(WEB_DIR, 'src');
const NODE_MODULES_DIR = join(WEB_DIR, 'node_modules');
const DIST_INDEX = join(WEB_DIR, 'dist', 'index.html');

/** Config files whose mtime can invalidate a previously built dist/index.html. */
const STALENESS_FILES = ['index.html', 'vite.config.ts', 'tailwind.config.ts', 'package.json'];

/** Newest mtime across web/src/** and the tracked frontend config files. */
function newestSourceMtimeMs(): number {
  let newest = 0;
  const visit = (target: string): void => {
    const stats = statSync(target, { throwIfNoEntry: false });
    if (!stats) return;
    if (stats.isDirectory()) {
      for (const entry of readdirSync(target, { withFileTypes: true })) {
        visit(join(target, entry.name));
      }
      return;
    }
    if (stats.mtimeMs > newest) newest = stats.mtimeMs;
  };

  visit(WEB_SRC_DIR);
  for (const file of STALENESS_FILES) visit(join(WEB_DIR, file));
  return newest;
}

function runBun(args: string[], label: string): void {
  console.log(`[web] ${label}...`);
  const result = spawnSync(process.execPath, args, { cwd: WEB_DIR, stdio: 'inherit' });
  if (result.error) {
    throw new Error(`${label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

/**
 * Ensure the SPA under web/ is installed and built before the server starts.
 * Set DEXTER_WEB_SKIP_BUILD=1 to bypass. Throws on install/build failure.
 */
export function ensureFrontendReady(): void {
  if (process.env.DEXTER_WEB_SKIP_BUILD === '1') {
    console.log('[web] DEXTER_WEB_SKIP_BUILD=1: skipping frontend install/build.');
    return;
  }

  if (!existsSync(NODE_MODULES_DIR)) {
    runBun(['install'], 'Installing frontend dependencies');
  }

  let rebuild = false;
  if (!existsSync(DIST_INDEX)) {
    rebuild = true;
  } else if (newestSourceMtimeMs() > statSync(DIST_INDEX).mtimeMs) {
    rebuild = true;
    console.log('[web] Frontend sources changed since the last build.');
  }

  if (rebuild) {
    runBun(['run', 'build'], 'Building frontend');
  } else {
    console.log('[web] Frontend build is up to date.');
  }
}

/** Build the platform-specific command that opens a URL in the default browser. */
function browserCommand(url: string): [string, string[]] {
  if (process.platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  if (process.platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

function logManualOpen(url: string): void {
  console.log(`[web] Could not open a browser automatically. Open this URL manually: ${url}`);
}

/**
 * Best-effort open of the app URL in the default browser. Never throws, so a
 * missing browser can never take down startup. Set DEXTER_WEB_OPEN=0 to disable.
 */
export function openInBrowser(url: string): void {
  if (process.env.DEXTER_WEB_OPEN === '0') {
    console.log('[web] DEXTER_WEB_OPEN=0: not opening a browser.');
    return;
  }

  const [command, args] = browserCommand(url);
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => logManualOpen(url));
    child.unref();
  } catch {
    logManualOpen(url);
  }
}
