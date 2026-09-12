import { randomBytes } from 'node:crypto';
import { startWebServer } from './server.js';

const DEFAULT_PORT = 3777;

function resolvePort(): number {
  const raw = process.env.DEXTER_WEB_PORT;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
}

const port = resolvePort();
const token = randomBytes(24).toString('base64url');
const server = startWebServer({ token, port });

console.log(`Dexter web agent running at http://127.0.0.1:${server.port}/?token=${token}`);
console.log('Press Ctrl+C to stop.');
