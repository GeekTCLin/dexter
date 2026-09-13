import type { DexterConfig, SearchProviderId } from "../types";
import type { ConversationSummary } from "../store/useStore";

function getToken(): string | null {
  return sessionStorage.getItem("dexter-token");
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers["X-Dexter-Token"] = token;
  }

  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export interface ChatResponse {
  runId: string;
  conversationId: string;
}

export async function postChat(
  message: string,
  conversationId?: string
): Promise<ChatResponse> {
  return request<ChatResponse>("/api/chat", {
    method: "POST",
    body: JSON.stringify({ message, conversationId }),
  });
}

export async function approveRun(
  runId: string,
  decision:
    | "allow-once"
    | "allow-session"
    | "allow-always"
    | "deny"
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/runs/${runId}/approve`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });
}

export async function answerRun(
  runId: string,
  answers: (string | string[])[],
  declined?: boolean
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/runs/${runId}/answer`, {
    method: "POST",
    body: JSON.stringify({ answers, declined }),
  });
}

export async function cancelRun(
  runId: string
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/runs/${runId}/cancel`, {
    method: "POST",
  });
}

export async function getConfig(): Promise<DexterConfig> {
  return request<DexterConfig>("/api/config");
}

export async function updateModel(
  provider: string,
  modelId: string
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/config/model", {
    method: "POST",
    body: JSON.stringify({ provider, modelId }),
  });
}

export async function updateApiKey(
  provider: string,
  key: string
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/config/api-key", {
    method: "POST",
    body: JSON.stringify({ provider, key }),
  });
}

export async function updateSearchProvider(
  searchProvider: SearchProviderId
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/config/search", {
    method: "POST",
    body: JSON.stringify({ searchProvider }),
  });
}

export async function updateMemory(
  enabled: boolean
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/config/memory", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export async function getToolResult(
  id: string
): Promise<{ content: string }> {
  return request<{ content: string }>(`/api/tool-results/${id}`);
}

export async function getConversations(): Promise<ConversationSummary[]> {
  return request("/api/conversations");
}

export async function getConversation(
  id: string
): Promise<{
  id: string;
  title: string;
  messages: Array<{ id?: string; role: string; content: string; timestamp: number }>;
}> {
  return request(`/api/conversations/${id}`);
}

export async function createConversation(
  title?: string
): Promise<{ id: string; title: string; createdAt: number }> {
  return request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

export function buildSSEUrl(runId: string, from?: number): string {
  const token = getToken();
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  if (from !== undefined) params.set("from", String(from));
  return `/api/runs/${runId}/events?${params.toString()}`;
}
