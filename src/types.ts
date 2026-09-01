/**
 * Shapes of the on-disk data Claude Code writes under ~/.claude.
 *
 * Nothing here is a guarantee: the files are an internal format that drifts
 * between releases, so every field is optional and readers are expected to
 * tolerate lines they do not recognise. The parsers in `parse.ts` narrow
 * these into the rows we actually store.
 */

/** Token accounting, present on assistant messages only. */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
}

/** One block inside a message's `content` array. */
export interface ContentBlock {
  type?: string;
  /** Set on `tool_use` blocks; the id a later `tool_result` refers back to. */
  id?: string;
  name?: string;
  input?: unknown;
  /** Set on `tool_result` blocks; points at the `tool_use` block's id. */
  tool_use_id?: string;
  content?: unknown;
  text?: string;
  thinking?: string;
  is_error?: boolean;
}

export interface TranscriptMessage {
  role?: string;
  model?: string;
  content?: string | ContentBlock[];
  usage?: Usage;
}

/**
 * A line that is not a message but carries one.
 *
 * Claude Code writes several kinds of `attachment` line; almost all are
 * plumbing. `queued_command` is the exception: it is what a message typed while
 * the assistant was still working is stored as, and it holds the same content
 * blocks a message would.
 */
export interface Attachment {
  type?: string;
  prompt?: ContentBlock[];
  commandMode?: string;
  timestamp?: string;
}

/** A single line of a `*.jsonl` transcript. */
export interface TranscriptLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  /** Present only in subagent transcripts. */
  agentId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean;
  message?: TranscriptMessage;
  /** Carried on `type: "ai-title"` lines; the human-readable session name. */
  aiTitle?: string;
  toolUseResult?: unknown;
  requestId?: string;
  attachment?: Attachment;
}

/**
 * `agent-<id>.meta.json` — the spawn edge for one subagent.
 *
 * `toolUseId` is the id of the `Agent` tool_use that created it, and resolves
 * into whichever transcript ran the call. `parentAgentId` is absent at depth 1,
 * where the parent is the session's main thread.
 */
export interface AgentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  parentAgentId?: string;
  spawnDepth?: number;
}

/** One entry of `~/.claude/tasks/<sessionId>/<n>.json`. */
export interface TaskFile {
  id?: string;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: string;
  blocks?: string[];
  blockedBy?: string[];
}

/** One entry of `~/.claude/sessions/<pid>.json` — a session alive right now. */
export interface LiveSessionFile {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  startedAt?: number;
  version?: string;
  kind?: string;
  entrypoint?: string;
  name?: string;
}
