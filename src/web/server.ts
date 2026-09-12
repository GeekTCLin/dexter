import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunManager } from './run-manager.js';
import { handleConfigRoute } from './config-routes.js';
import { getConversation, listConversations } from './chat-store.js';
import type { ApprovalDecision } from '../agent/types.js';
import type { AnswerBody, ApproveBody, ChatRequestBody, SseFrame } from './types.js';

const DEFAULT_DIST_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));
const DECISIONS = new Set<ApprovalDecision>(['allow-once', 'allow-session', 'allow-always', 'deny']);

export interface WebServerOptions {
  token: string;
  port: number;
  distDir?: string;
}

export interface WebServer {
  port: number;
  stop(): void;
  runManager: RunManager;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Start the local Bun HTTP server. Binds 127.0.0.1 only. */
export function startWebServer(options: WebServerOptions): WebServer {
  const distDir = resolve(options.distDir ?? DEFAULT_DIST_DIR);
  const runManager = new RunManager();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port,
    // Bun's default is 10s, which drops long SSE tool waits (e.g. memory_search).
    // 255 is Bun's maximum allowed idle timeout.
    idleTimeout: 255,
    fetch: (req) => handleRequest(req, options.token, distDir, runManager),
  });

  return {
    port: server.port ?? options.port,
    stop: () => server.stop(true),
    runManager,
  };
}

async function handleRequest(
  req: Request,
  token: string,
  distDir: string,
  runManager: RunManager,
): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (pathname.startsWith('/api/')) {
    if (!isAuthorized(req, url, token)) {
      return json({ error: 'Unauthorized' }, 401);
    }
    return handleApi(req, pathname, url, runManager);
  }

  return serveStatic(pathname, distDir);
}

/** Token may arrive as an X-Dexter-Token header or a ?token= query (EventSource). */
function isAuthorized(req: Request, url: URL, token: string): boolean {
  const header = req.headers.get('X-Dexter-Token');
  if (header && header === token) return true;
  return url.searchParams.get('token') === token;
}

async function handleApi(
  req: Request,
  pathname: string,
  url: URL,
  runManager: RunManager,
): Promise<Response> {
  const method = req.method.toUpperCase();
  const body = method === 'POST' ? await readJson(req) : undefined;

  const configResponse = await handleConfigRoute(method, pathname, body);
  if (configResponse) return configResponse;

  if (method === 'POST' && pathname === '/api/chat') {
    const chat = body as ChatRequestBody | null;
    if (!chat || typeof chat.message !== 'string' || !chat.message.trim()) {
      return json({ error: 'message is required' }, 400);
    }
    const result = await runManager.startRun({
      conversationId: typeof chat.conversationId === 'string' ? chat.conversationId : undefined,
      message: chat.message,
    });
    return json(result);
  }

  if (method === 'GET' && pathname === '/api/conversations') {
    return json(await listConversations());
  }

  const conversationMatch = /^\/api\/conversations\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && conversationMatch) {
    const conversation = await getConversation(decodeURIComponent(conversationMatch[1]));
    return conversation ? json(conversation) : json({ error: 'Not found' }, 404);
  }

  const eventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(pathname);
  if (method === 'GET' && eventsMatch) {
    const runId = decodeURIComponent(eventsMatch[1]);
    if (!runManager.hasRun(runId)) return json({ error: 'Run not found' }, 404);
    return createSseResponse(req, url, runId, runManager);
  }

  const approveMatch = /^\/api\/runs\/([^/]+)\/approve$/.exec(pathname);
  if (method === 'POST' && approveMatch) {
    const decision = (body as ApproveBody | null)?.decision;
    if (!isDecision(decision)) return json({ error: 'invalid decision' }, 400);
    return json({ ok: runManager.approve(decodeURIComponent(approveMatch[1]), decision) });
  }

  const answerMatch = /^\/api\/runs\/([^/]+)\/answer$/.exec(pathname);
  if (method === 'POST' && answerMatch) {
    const payload = body as AnswerBody | null;
    const answers = Array.isArray(payload?.answers) ? payload.answers : [];
    const ok = runManager.answer(
      decodeURIComponent(answerMatch[1]),
      answers,
      payload?.declined === true,
    );
    return json({ ok });
  }

  const cancelMatch = /^\/api\/runs\/([^/]+)\/cancel$/.exec(pathname);
  if (method === 'POST' && cancelMatch) {
    return json({ ok: runManager.cancel(decodeURIComponent(cancelMatch[1])) });
  }

  const toolResultMatch = /^\/api\/tool-results\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && toolResultMatch) {
    const content = runManager.getToolResult(decodeURIComponent(toolResultMatch[1]));
    return content === null ? json({ error: 'Not found' }, 404) : json({ content });
  }

  return json({ error: 'Not found' }, 404);
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function isDecision(value: unknown): value is ApprovalDecision {
  return typeof value === 'string' && DECISIONS.has(value as ApprovalDecision);
}

function parseFrom(url: URL, lastEventId: string | null): number {
  const raw = url.searchParams.get('from') ?? lastEventId;
  if (raw === null) return -1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

function formatAgentFrame(frame: SseFrame): string {
  return `id: ${frame.seq}\nevent: agent\ndata: ${JSON.stringify(frame)}\n\n`;
}

function formatDoneFrame(runId: string, frame: SseFrame | null): string {
  const answer = frame && typeof frame.payload.answer === 'string' ? frame.payload.answer : '';
  return `event: done\ndata: ${JSON.stringify({ runId, answer })}\n\n`;
}

function createSseResponse(req: Request, url: URL, runId: string, runManager: RunManager): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stopHeartbeat = () => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        stopHeartbeat();
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // Stream already closed by the client.
        }
      };
      const listener = (frame: SseFrame) => {
        send(formatAgentFrame(frame));
        if (frame.type === 'done') {
          send(formatDoneFrame(runId, frame));
          queueMicrotask(finish);
        }
      };

      const unsub = runManager.subscribe(runId, parseFrom(url, req.headers.get('Last-Event-ID')), listener);
      if (!unsub) {
        send(formatDoneFrame(runId, null));
        queueMicrotask(finish);
        return;
      }
      unsubscribe = unsub;
      req.signal.addEventListener('abort', finish, { once: true });

      // SSE comment heartbeat keeps the connection alive across tool waits that
      // would otherwise trip the server idle timeout.
      heartbeat = setInterval(() => send(': ping\n\n'), 15_000);
    },
    cancel() {
      closed = true;
      stopHeartbeat();
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

async function serveStatic(pathname: string, distDir: string): Promise<Response> {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = resolve(distDir, relative);

  // Prevent path traversal outside the built SPA directory.
  const root = resolve(distDir);
  const boundary = process.platform === 'win32' ? '\\' : '/';
  if (target !== root && !target.startsWith(`${root}${boundary}`)) {
    return new Response('Not found', { status: 404 });
  }

  let file = Bun.file(target);
  if (!(await file.exists())) {
    file = Bun.file(join(root, 'index.html'));
    if (!(await file.exists())) {
      return new Response('Web UI not built. Run: cd web && bun run build', { status: 404 });
    }
  }

  return new Response(file, {
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
  });
}
