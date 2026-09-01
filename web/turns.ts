import type { Message, ToolCall } from "../src/contract.ts";

/**
 * Collapsing raw transcript lines into the turns a person actually took.
 *
 * A transcript is not a conversation: of ~34,700 lines in this index, only
 * ~1,430 are real user turns and ~3,550 carry assistant prose. The rest is
 * structure. One assistant reply is written as several lines sharing a request
 * id — thinking, then text, then one line per tool call — and every tool result
 * comes back as a `user` line carrying nothing but a `tool_result` block. Read
 * literally, that renders as a user message interrupting every tool call.
 *
 * So: drop the tool-result lines, because the result is already attached to the
 * call that produced it, merge lines that share a request id back into the
 * single reply they were written as, and fold a reply that only ran tools onto
 * the reply that last said something — an agentic loop otherwise renders as a
 * stack of near-identical headers wrapping one line each.
 */

/**
 * What a turn actually is, which its `role` alone does not say.
 *
 * Claude Code injects several things into the transcript as `user` lines that
 * the person never typed: a background task finishing, the echo of a slash
 * command, the output of a local command. Rendered by role they all read as the
 * user interrupting — most visibly a subagent's completion report, which is one
 * of the more interesting events in an agent run and the least like a user turn.
 */
export type TurnKind =
  | "user"
  | "assistant"
  | "task"
  | "command"
  | "output"
  | "skill"
  | "system";

/**
 * Contents of the first matching `<tag>`, or null.
 *
 * Falls back to "everything after the opening tag" when the closing tag is
 * absent, because long notifications are truncated by the indexer and would
 * otherwise be read as having no body at all.
 */
function tag(name: string, source: string): string | null {
  const closed = source.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  if (closed?.[1] !== undefined) return closed[1].trim();

  const open = source.indexOf(`<${name}>`);
  if (open === -1) return null;
  return source.slice(open + name.length + 2).trim() || null;
}

interface Injected {
  kind: TurnKind;
  /** Short label for the badge, in place of the role. */
  label: string;
  /** The part worth reading, with the envelope removed. */
  text: string;
}

/**
 * Recognises an injected `user` line and unwraps it.
 *
 * Returns null for genuine prose, which is the overwhelming majority: roughly
 * 1,250 of 1,430 user lines in this index are really the person talking.
 */
export function classifyInjected(text: string): Injected | null {
  // Invoking a skill injects its whole SKILL.md as a `user` line, prefixed with
  // where it was loaded from. Read as a user turn that is the human suddenly
  // reciting several thousand words of instructions they never wrote.
  const skill = text.match(/^Base directory for this skill: (\S+)\n+([\s\S]*)$/);
  if (skill !== null) {
    const path = skill[1] ?? "";
    const name = path.split("/").filter(Boolean).pop() ?? "skill";
    return { kind: "skill", label: `/${name}`, text: (skill[2] ?? "").trim() };
  }

  // A repeat invocation loads nothing and says so, again as a `user` line and
  // again detached from the call it answers. Anchored to the whole message, so
  // a reply that merely quotes the sentence is not mistaken for one.
  const reloaded = text.trim().match(/^Skill \/(\S+) is already loaded above; instructions unchanged\.$/);
  if (reloaded !== null) {
    return { kind: "skill", label: `/${reloaded[1] ?? "skill"}`, text: text.trim() };
  }

  if (!text.startsWith("<")) return null;

  if (text.startsWith("<task-notification>")) {
    const summary = tag("summary", text);
    const body = tag("result", text) ?? tag("event", text) ?? "";
    return {
      kind: "task",
      label: tag("result", text) !== null ? "agent report" : "background task",
      text: [summary, body].filter(Boolean).join("\n\n") || text,
    };
  }

  const command = tag("command-name", text);
  if (command !== null) {
    const args = tag("command-args", text);
    return { kind: "command", label: command, text: args ?? "" };
  }

  const stdout = tag("local-command-stdout", text);
  if (stdout !== null) return { kind: "output", label: "command output", text: stdout };

  const caveat = tag("local-command-caveat", text);
  if (caveat !== null) return { kind: "system", label: "note", text: caveat };

  return null;
}

export interface Turn {
  /** What this turn is; `role` cannot distinguish a person from an injection. */
  kind: TurnKind;
  /** Badge text: the role, or what the injection actually is. */
  label: string;
  /** The first line's uuid; stable across re-fetches. */
  id: string;
  role: string;
  /** Lines merged into this turn, in order. */
  messages: Message[];
  text: string;
  toolCalls: ToolCall[];
  model: string | null;
  timestamp: string | null;
  tokens: number;
  thinkingTokens: number;
  firstSeq: number;
  lastSeq: number;
  /** The turn thought but neither spoke nor acted — worth showing as a beat. */
  thinkingOnly: boolean;
  /** How many separate model requests were folded in; 1 unless coalesced. */
  rounds: number;
  /** Request keys already added to `tokens`, so no reply is charged twice. */
  countedRequests: Set<string>;
  hasImage: boolean;
  isNew: boolean;
}

/**
 * Where the client saved an attachment, appended to the message the user typed.
 *
 * Redundant here: in every message carrying one, the image itself is attached
 * and rendered directly beneath the prose, so the path is a second, uglier copy
 * of something already on screen.
 */
const ATTACHMENT_PATH = /\n*\[Attached [a-z]+ "[^"]*" is saved at: [^\]]*\]/g;

/**
 * A note describing an image's dimensions and scale factor.
 *
 * Written for the model, so it can map coordinates back onto the original, and
 * it arrives as a whole `user` line of its own with no image attached. There is
 * nothing in it for a reader.
 */
const IMAGE_GEOMETRY = /^\[Image: original \d+x\d+, displayed at \d+x\d+\..*\]$/s;

/** Removes client bookkeeping the reader has no use for. */
function cleanText(text: string): string {
  return text.replace(ATTACHMENT_PATH, "").trim();
}

/**
 * True for a line that exists only to deliver tool output.
 *
 * Rows indexed before `blockTypes` was recorded have none, so fall back to
 * shape: a user line with no prose and no calls of its own is a tool result in
 * every sample of this data. Real user turns that attach an image still carry
 * their text alongside it, so they survive the fallback.
 */
function isToolResultOnly(message: Message): boolean {
  if (message.blockTypes.length > 0) {
    return message.blockTypes.every((type) => type === "tool_result");
  }
  return message.role === "user" && !message.text && message.toolCalls.length === 0;
}

function sumTokens(message: Message): number {
  const { input, output, cacheRead, cacheCreation } = message.tokens;
  return input + output + cacheRead + cacheCreation;
}

/**
 * Identifies the model request a line belongs to, for counting cost once.
 *
 * Usage is reported per request and every line of one reply repeats the same
 * running total, so a turn must add each request once however many lines it
 * spans. `requestId` says so outright. Without it — rows indexed before that
 * column existed — the repeated total is itself the signal: consecutive lines
 * carrying identical usage are the same request. Two genuinely distinct
 * requests would have to agree to the token before colliding, and if they do
 * both are zero-cost anyway.
 */
function requestKey(message: Message): string {
  return message.requestId ?? `usage:${sumTokens(message)}:${message.thinkingTokens}`;
}

/** Adds a request's cost to a turn unless that request is already counted. */
function countRequest(turn: Turn, message: Message): void {
  const key = requestKey(message);
  if (turn.countedRequests.has(key)) return;
  turn.countedRequests.add(key);
  turn.tokens += sumTokens(message);
  turn.thinkingTokens += message.thinkingTokens;
}

function startTurn(message: Message, isNew: boolean): Turn {
  const role = message.role ?? message.type ?? "message";
  const injected = role === "user" ? classifyInjected(message.text ?? "") : null;

  return {
    id: message.uuid,
    role,
    kind: injected?.kind ?? (role === "user" || role === "assistant" ? role : "system"),
    label: injected?.label ?? role,
    messages: [message],
    text: cleanText(injected?.text ?? message.text ?? ""),
    toolCalls: [...message.toolCalls],
    model: message.model,
    timestamp: message.timestamp,
    tokens: sumTokens(message),
    thinkingTokens: message.thinkingTokens,
    countedRequests: new Set([requestKey(message)]),
    firstSeq: message.seq,
    lastSeq: message.seq,
    thinkingOnly: false,
    rounds: 1,
    hasImage: message.blockTypes.includes("image"),
    isNew,
  };
}

function extendTurn(turn: Turn, message: Message, isNew: boolean): void {
  turn.messages.push(message);
  const text = cleanText(message.text ?? "");
  if (text) turn.text = turn.text ? `${turn.text}\n\n${text}` : text;
  turn.toolCalls.push(...message.toolCalls);
  turn.model ??= message.model;
  turn.timestamp ??= message.timestamp;
  turn.lastSeq = message.seq;
  turn.hasImage ||= message.blockTypes.includes("image");
  turn.isNew ||= isNew;
  countRequest(turn, message);
}

/**
 * Folds a reply that only acted into the one that last spoke.
 *
 * An agentic loop emits a reply with prose and a tool call, then several more
 * replies that are nothing but tool calls. Rendered one per request that is a
 * stack of near-identical headers wrapping a single line each. Collapsing the
 * wordless ones onto the statement they follow gives what actually happened:
 * the model said this, then ran these.
 *
 * Cost is accumulated per request, not per turn: these are different requests
 * that each cost their own, but their lines repeat a running total, so folding
 * goes through the same count-once rule the first pass uses.
 */
function coalesce(turns: Turn[]): Turn[] {
  const out: Turn[] = [];

  for (const turn of turns) {
    const previous = out[out.length - 1];
    const foldable =
      previous !== undefined &&
      previous.role === "assistant" &&
      turn.role === "assistant" &&
      turn.text === "";

    if (!foldable || previous === undefined) {
      out.push(turn);
      continue;
    }

    previous.messages.push(...turn.messages);
    previous.toolCalls.push(...turn.toolCalls);
    previous.lastSeq = turn.lastSeq;
    previous.rounds += 1;
    for (const message of turn.messages) countRequest(previous, message);
    previous.hasImage ||= turn.hasImage;
    previous.isNew ||= turn.isNew;
    previous.model ??= turn.model;
  }

  return out;
}

/**
 * Moves a skill's instructions onto the `Skill` call that loaded them.
 *
 * The call already exists a turn or two earlier, carrying only the stub result
 * "Launching skill: <name>"; the body arrives separately as its own line. They
 * are two halves of one event, so the body becomes the call's content and the
 * whole invocation collapses into a single row.
 *
 * Returns false when the call is not on this page -- a skill invoked just
 * before a page boundary -- so the body can still be shown on its own rather
 * than vanishing.
 */
function attachSkillBody(turns: Turn[], body: string): boolean {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn === undefined) continue;
    for (let j = turn.toolCalls.length - 1; j >= 0; j--) {
      const call = turn.toolCalls[j];
      if (call === undefined || call.name !== "Skill") continue;
      // The stub result is also the marker for "not filled yet", so a second
      // invocation of the same skill cannot overwrite the first one's body.
      const unfilled = typeof call.result !== "string" || call.result.startsWith("Launching skill:");
      if (!unfilled) continue;
      // Replaced rather than mutated: these objects come straight from the
      // fetched page and are re-grouped on every update.
      turn.toolCalls[j] = { ...call, result: body };
      return true;
    }
  }
  return false;
}

/**
 * Groups a page of messages into turns.
 *
 * Two passes: lines sharing a request id become one reply, then replies that
 * only ran tools fold onto the reply that last said something.
 */
export function buildTurns(messages: readonly Message[], freshUuids: ReadonlySet<string>): Turn[] {
  const turns: Turn[] = [];
  let open: Turn | null = null;
  let openRequestId: string | null = null;

  for (const message of messages) {
    if (message.text !== null && IMAGE_GEOMETRY.test(message.text.trim())) {
      // Pure coordinate plumbing; the image it describes is rendered elsewhere.
      continue;
    }

    if (isToolResultOnly(message)) {
      // The payload already rides on the call in an earlier turn; if that call
      // is on this page it is rendered there, and if it is not, showing an
      // empty line here would explain nothing.
      continue;
    }

    const injectedSkill =
      message.role === "user" && message.text !== null ? classifyInjected(message.text) : null;
    if (injectedSkill?.kind === "skill" && attachSkillBody(turns, injectedSkill.text)) {
      // Folded onto the `Skill` call that asked for it; showing it again as its
      // own block would render one event twice, back to back.
      continue;
    }

    const isNew = freshUuids.has(message.uuid);
    const canExtend =
      open !== null &&
      openRequestId !== null &&
      message.requestId === openRequestId &&
      message.role === open.role;

    if (canExtend && open !== null) {
      extendTurn(open, message, isNew);
      continue;
    }

    open = startTurn(message, isNew);
    openRequestId = message.requestId;
    turns.push(open);
  }

  const grouped = coalesce(turns);
  for (const turn of grouped) {
    turn.thinkingOnly =
      turn.text === "" && turn.toolCalls.length === 0 && turn.thinkingTokens > 0;
  }

  return grouped;
}
