import { randomBytes } from 'node:crypto';
import { startWebServer } from './server.js';
import { ensureFrontendReady, openInBrowser } from './startup.js';

const DEFAULT_PORT = 3777;

function resolvePort(): number {
  const raw = process.env.DEXTER_WEB_PORT;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
}

const port = resolvePort();

// Fail fast: never start a server that would 404 because the SPA isn't built.
try {
  ensureFrontendReady();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[web] ${message}`);
  console.error('[web] Frontend is not ready. Run: cd web && bun install && bun run build');
  process.exit(1);
}

const token = randomBytes(24).toString('base64url');
const server = startWebServer({ token, port });

const url = `http://127.0.0.1:${server.port}/?token=${token}`;
console.log(`Dexter web agent running at ${url}`);
console.log('Press Ctrl+C to stop.');

openInBrowser(url);
