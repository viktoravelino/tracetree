import type {
  LiveSessionInfo,
  MessagePage,
  Overview,
  Project,
  SessionDetail,
  SessionSummary,
} from "../src/contract.ts";

/**
 * Typed fetch wrappers over the routes documented in `src/contract.ts`.
 * Every response type comes from the contract; nothing is re-declared here.
 */

const BASE = "/api";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type QueryValue = string | number | boolean | undefined;

async function request<T>(
  path: string,
  params: Record<string, QueryValue>,
  signal?: AbortSignal,
): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  const response = await fetch(`${BASE}${path}${query ? `?${query}` : ""}`, {
    signal,
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new ApiError(await errorText(response), response.status);
  return (await response.json()) as T;
}

/** Servers answer errors as `{ error: string }`; fall back to the status line. */
async function errorText(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const { error } = body as { error: unknown };
      if (typeof error === "string") return error;
    }
  } catch {
    // Not JSON — the status text is the best we have.
  }
  return `${response.status} ${response.statusText}`.trim();
}

export interface SessionListParams {
  /** Canonical repo path; percent-encoding is handled by URLSearchParams. */
  project?: string;
  search?: string;
  withAgents?: boolean;
  limit?: number;
  offset?: number;
}

export interface MessageParams {
  /** Agent id, or `""` for the session's main thread. */
  agent?: string;
  limit?: number;
  offset?: number;
}

export const api = {
  overview: (signal?: AbortSignal) => request<Overview>("/overview", {}, signal),

  projects: (signal?: AbortSignal) => request<Project[]>("/projects", {}, signal),

  sessions: (params: SessionListParams, signal?: AbortSignal) =>
    request<SessionSummary[]>("/sessions", { ...params }, signal),

  session: (id: string, signal?: AbortSignal) =>
    request<SessionDetail>(`/sessions/${encodeURIComponent(id)}`, {}, signal),

  messages: (id: string, params: MessageParams, signal?: AbortSignal) =>
    request<MessagePage>(
      `/sessions/${encodeURIComponent(id)}/messages`,
      // An empty `agent` means the main thread, which is also the server
      // default, so dropping it from the query string is the same request.
      { ...params },
      signal,
    ),

  live: (signal?: AbortSignal) => request<LiveSessionInfo[]>("/live", {}, signal),
};
