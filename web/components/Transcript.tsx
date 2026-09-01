import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDownIcon } from "lucide-react";

import { DEFAULT_MESSAGE_LIMIT } from "../../src/contract.ts";
import { api } from "../api.ts";
import { absoluteTime, compactNumber, exactNumber, relativeTime } from "../format.ts";
import { useAsync } from "../useAsync.ts";
import { Empty, ErrorState, Loading } from "./States.tsx";
import { Markdown } from "./Markdown.tsx";
import { MessageImages, collectImages } from "./MessageImages.tsx";
import { ToolCallView } from "./ToolCallView.tsx";
import { buildTurns, type Turn, type TurnKind } from "../turns.ts";
import type { ToolCall } from "../../src/contract.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";

const PAGE_SIZES = [100, 200, 500] as const;
const TEXT_PREVIEW = 1_500;
const TEXT_MAX = 40_000;

/** How close to the bottom still counts as "at the bottom", in pixels. */
const BOTTOM_SLACK = 24;
/** How long a just-arrived message keeps its marker. */
const NEW_MARK_MS = 12_000;

const NO_MESSAGES: ReadonlySet<string> = new Set<string>();

/** Role reads as a status, so it gets a badge tone rather than a colour. */
/**
 * Only a real person gets the solid badge. Everything Claude Code injects as a
 * `user` line — a finished background task, a slash command, local output — is
 * outlined, so a subagent's report never reads as the user talking.
 */
const KIND_VARIANT: Record<TurnKind, "default" | "secondary" | "outline"> = {
  user: "default",
  assistant: "secondary",
  task: "outline",
  command: "outline",
  skill: "outline",
  output: "outline",
  system: "outline",
};

interface TranscriptProps {
  sessionId: string;
  /** `""` for the session's main thread. */
  agentId: string;
  threadLabel: ReactNode;
  refreshKey: number;
  /** Bumped when a `sync` names this session — the cue to reload this page. */
  revision: number;
  /** Whether the session is running right now; decides the follow default. */
  live: boolean;
  onOpenAgent: (agentId: string) => void;
}

/**
 * One thread's messages, paginated: a thread can run to thousands of rows.
 *
 * Follow mode is the difference between an archive and a live view. When it is
 * on, the transcript pins itself to the *last* page and to the bottom of that
 * page, reloads on every sync naming the session, and marks what just arrived.
 * The user always wins over the machine: any upward scroll turns following off
 * so history can be read, and the "N new messages" button is the way back.
 */
export function Transcript({
  sessionId,
  agentId,
  threadLabel,
  refreshKey,
  revision,
  live,
  onOpenAgent,
}: TranscriptProps) {
  const [limit, setLimit] = useState<number>(DEFAULT_MESSAGE_LIMIT);
  const [offset, setOffset] = useState(0);
  // A live session is almost always opened to watch it, so follow defaults on.
  // The component is remounted per thread, so this is re-decided each time.
  const [follow, setFollow] = useState(live);
  /** Total in this thread as of the last response; `null` before the first. */
  const [total, setTotal] = useState<number | null>(null);
  /** Total at the moment following stopped, so "new" can be counted from it. */
  const [baseline, setBaseline] = useState<number | null>(null);
  const [freshUuids, setFreshUuids] = useState<ReadonlySet<string>>(NO_MESSAGES);

  const scroller = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const followButton = useRef<HTMLButtonElement | null>(null);
  const lastTop = useRef(0);
  // Read by the resize observer below, which is installed once.
  const followRef = useRef(follow);
  followRef.current = follow;
  /** Following was dropped by scrolling, not by the toggle or the pager. */
  const disengagedByScroll = useRef(false);

  // Which page "the newest messages" is depends on the total, and only a
  // response can tell us that. Rather than pull a whole page we will throw
  // away, the first request while following is a one-row probe for `total`.
  const probing = follow && total === null;
  const requestLimit = probing ? 1 : limit;
  const requestOffset = probing ? 0 : offset;

  const state = useAsync(
    (signal) =>
      api.messages(sessionId, { agent: agentId, limit: requestLimit, offset: requestOffset }, signal),
    [sessionId, agentId, requestLimit, requestOffset, refreshKey, revision],
    // Reloading on every sync must not blank the pane the user is reading.
    { keepPrevious: true },
  );

  const data = state.status === "ready" ? state.data : null;
  // A page carries the window it answers, so a response left over from the
  // previous request is never mistaken for the current one. That is what stops
  // the probe, and any page change, from flashing the wrong messages.
  const page =
    !probing && data !== null && data.offset === requestOffset && data.limit === requestLimit
      ? data
      : null;

  // Raw lines are not turns: tool results arrive as their own `user` lines and
  // one reply is split across several. Group before rendering, not while.
  const turns = useMemo(
    () => (page === null ? [] : buildTurns(page.messages, freshUuids)),
    [page, freshUuids],
  );

  // Learn the total from every response, and while following, keep the page
  // pinned to the end. Both are set in one pass so the corrected request is the
  // only one that goes out.
  useEffect(() => {
    if (data === null) return;
    setTotal(data.total);
    if (follow) setOffset(lastOffsetFor(data.total, limit));
    else if (baseline === null) setBaseline(data.total);
    // `follow`, `limit` and `baseline` come from the same render as `data`.
  }, [data]);

  // Mark what arrived since the last response for this exact page. A page or
  // thread change seeds the set instead, so switching pages never lights up a
  // hundred rows as "new".
  const seen = useRef<{ key: string; uuids: Set<string> } | null>(null);
  useEffect(() => {
    if (page === null) return;
    const key = `${page.offset}:${page.limit}`;
    const uuids = page.messages.map((message) => message.uuid);
    const previous = seen.current;
    if (previous === null || previous.key !== key) {
      seen.current = { key, uuids: new Set(uuids) };
      setFreshUuids(NO_MESSAGES);
      return;
    }
    const added = uuids.filter((uuid) => !previous.uuids.has(uuid));
    if (added.length === 0) return;
    for (const uuid of added) previous.uuids.add(uuid);
    setFreshUuids(new Set(added));
  }, [page]);

  // Let the markers lapse, or a busy thread ends up permanently striped.
  useEffect(() => {
    if (freshUuids.size === 0) return;
    const timer = setTimeout(() => setFreshUuids(NO_MESSAGES), NEW_MARK_MS);
    return () => clearTimeout(timer);
  }, [freshUuids]);

  // Pin to the bottom after every rendered change, before the browser paints,
  // so arriving messages never flash in halfway up. Only `scrollTop` is
  // touched: nothing here can move focus. `freshUuids` is a dependency because
  // the markers are added in a later pass and change the content height.
  useLayoutEffect(() => {
    if (!follow) return;
    const element = scroller.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
    lastTop.current = element.scrollTop;
  }, [follow, page, freshUuids]);

  /**
   * The commit that adds a message is not always the one that settles its
   * height: a "new" marker can wrap a header line, a tool payload can expand,
   * a font can swap. Without this the view ends up parked a few pixels off the
   * bottom and quietly drifts further with every arrival.
   */
  useEffect(() => {
    const element = scroller.current;
    const inner = content.current;
    if (element === null || inner === null) return;
    const observer = new ResizeObserver(() => {
      if (!followRef.current) return;
      element.scrollTop = element.scrollHeight;
      lastTop.current = element.scrollTop;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  /**
   * Following is a claim about where the user is looking, so the scroll
   * position is what maintains it. Comparing against the previous offset means
   * only real upward movement disengages — the pin above always scrolls down,
   * and content growing underneath moves nothing at all.
   */
  const onScroll = () => {
    const element = scroller.current;
    if (element === null) return;
    const top = element.scrollTop;
    const movedUp = top < lastTop.current - 1;
    lastTop.current = top;
    const atBottom = element.scrollHeight - top - element.clientHeight <= BOTTOM_SLACK;

    if (follow && movedUp && !atBottom) {
      setFollow(false);
      setBaseline(total);
      disengagedByScroll.current = true;
      return;
    }
    // Scrolling back down resumes, but only if scrolling is what stopped it:
    // an explicit Follow-off must not be undone by a stray scroll event.
    if (!follow && atBottom && disengagedByScroll.current) {
      disengagedByScroll.current = false;
      setFollow(true);
      setBaseline(null);
    }
  };

  const startFollowing = () => {
    disengagedByScroll.current = false;
    setBaseline(null);
    setFollow(true);
    if (total !== null) setOffset(lastOffsetFor(total, limit));
  };

  const stopFollowing = () => {
    disengagedByScroll.current = false;
    setFollow(false);
    setBaseline(total);
  };

  /** Paging is an explicit move away from the tail. */
  const goTo = (nextOffset: number) => {
    disengagedByScroll.current = false;
    setFollow(false);
    setBaseline(total);
    setOffset(Math.max(0, nextOffset));
    const element = scroller.current;
    if (element !== null) {
      element.scrollTop = 0;
      lastTop.current = 0;
    }
  };

  const shownTotal = total ?? 0;
  const shownFrom = page === null || shownTotal === 0 ? 0 : offset + 1;
  const shownTo = page === null ? 0 : Math.min(offset + page.messages.length, shownTotal);
  const newCount = baseline === null || total === null ? 0 : Math.max(0, total - baseline);
  const behind = !follow && newCount > 0;

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      aria-label="Transcript"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-border bg-card px-5 py-2.5">
        <h3 className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-foreground">
          {threadLabel}
        </h3>
        <div className="ml-auto flex items-center gap-2 font-mono text-[0.6875rem] text-muted-foreground">
          <Toggle
            size="sm"
            variant="outline"
            ref={followButton}
            pressed={follow}
            aria-pressed={follow}
            // `aria-pressed:bg-muted` from the Toggle variant already carries
            // the "on" background; colour is what makes it read as *live*.
            className={cn("font-mono", follow && "border-primary/50 text-primary")}
            title={
              follow
                ? "Pinned to the newest messages. Scroll up to read history."
                : "Jump to the newest messages and keep up as they arrive."
            }
            onClick={() => (follow ? stopFollowing() : startFollowing())}
          >
            Follow
          </Toggle>
          <label className="sr-only" htmlFor="page-size">
            Messages per page
          </label>
          <Select
            value={limit}
            onValueChange={(next) => {
              // A native `<select>` cannot report "nothing"; Base UI's typing can.
              if (next === null) return;
              setLimit(next);
              setOffset(follow && total !== null ? lastOffsetFor(total, next) : 0);
            }}
          >
            <SelectTrigger id="page-size" size="sm" className="font-mono">
              <SelectValue>{`${limit} / page`}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={size} className="font-mono">
                  {size} / page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="tabular-nums">
            {page !== null
              ? `${exactNumber(shownFrom)}–${exactNumber(shownTo)} of ${exactNumber(shownTotal)}`
              : "…"}
          </span>
          <Button
            variant="outline"
            size="xs"
            className="font-mono"
            onClick={() => goTo(offset - limit)}
            disabled={offset === 0}
          >
            Prev
          </Button>
          <Button
            variant="outline"
            size="xs"
            className="font-mono"
            onClick={() => goTo(offset + limit)}
            disabled={page === null || offset + limit >= shownTotal}
          >
            Next
          </Button>
        </div>
      </div>

      {/* Wraps the scroller so the "new messages" affordance can sit over it. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* A plain overflow container on purpose: follow mode assigns
            `scrollTop` here and measures `scrollHeight`/`clientHeight` here, so
            the scrollport has to be this element and not an inner viewport. */}
        <div
          className="min-h-0 flex-1 overflow-y-auto pt-1.5 pb-10"
          ref={scroller}
          onScroll={onScroll}
        >
          {/* Wrapper exists purely so the observer above has a box whose height
              is the content height; the scroller only ever reports its own. */}
          <div ref={content}>
            {state.status === "loading" && <Loading what="messages" />}
            {state.status === "error" && <ErrorState what="messages" message={state.error} />}
            {state.status === "ready" && page === null && <Loading what="the newest messages" />}
            {page !== null && page.messages.length === 0 && (
              <Empty>This thread has no messages.</Empty>
            )}
            {page !== null && page.messages.length > 0 && turns.length === 0 && (
              <Empty>This page holds only tool output, shown with the calls that made it.</Empty>
            )}
            {turns.map((turn) => (
              <TurnView
                key={turn.id}
                turn={turn}
                sessionId={sessionId}
                onOpenAgent={onOpenAgent}
              />
            ))}
          </div>
        </div>

        {behind && (
          <Button
            size="sm"
            className="absolute bottom-3.5 left-1/2 -translate-x-1/2 rounded-full font-mono shadow-lg"
            onClick={() => {
              startFollowing();
              // The pill unmounts on click, so hand focus to the equivalent
              // persistent control rather than dropping it on the document.
              followButton.current?.focus();
            }}
          >
            {exactNumber(newCount)} new message{newCount === 1 ? "" : "s"}
            <ArrowDownIcon aria-hidden="true" />
          </Button>
        )}
        <span className="sr-only" role="status">
          {behind ? `${newCount} new message${newCount === 1 ? "" : "s"} below.` : ""}
        </span>
      </div>
    </section>
  );
}

/**
 * Offset that puts the newest message at the end of a full page.
 *
 * A sliding window, not the last cell of a fixed page grid. On the grid, a
 * thread whose length has just crossed a boundary leaves the newest page
 * holding only the overflow: send one message at 1,501 of 1,514 and following
 * jumps to a page of fourteen, with everything before it gone from view. The
 * window always ends at the newest message and is always as full as the thread
 * allows.
 */
function lastOffsetFor(total: number, limit: number): number {
  if (total <= 0 || limit <= 0) return 0;
  return Math.max(0, total - limit);
}

/**
 * One turn: a real user message, or one assistant reply with its thinking,
 * prose and tool calls together rather than split across four lines.
 */
function TurnView({
  turn,
  sessionId,
  onOpenAgent,
}: {
  turn: Turn;
  sessionId: string;
  onOpenAgent: (agentId: string) => void;
}) {
  const seq = turn.firstSeq === turn.lastSeq ? `#${turn.firstSeq}` : `#${turn.firstSeq}-${turn.lastSeq}`;
  // A turn's images are spread across the lines it merged, so gather them the
  // same way its prose was gathered.
  const images = useMemo(() => collectImages(turn.messages), [turn.messages]);
  // An image is content: a turn carrying only a screenshot is not silent.
  const silent =
    turn.text === "" && turn.toolCalls.length === 0 && images.length === 0 && !turn.thinkingOnly;

  return (
    <article
      className={cn(
        "border-b border-l-2 border-border border-l-transparent px-5 py-4",
        turn.isNew && "border-l-primary bg-primary/5",
      )}
      data-new={turn.isNew ? "true" : undefined}
    >
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 font-mono text-[0.6875rem] text-muted-foreground">
        <Badge
          variant={KIND_VARIANT[turn.kind] ?? "outline"}
          className="font-mono tracking-wide uppercase"
          data-role={turn.role}
          data-kind={turn.kind}
        >
          {turn.label}
        </Badge>
        {turn.isNew && (
          <Badge
            variant="outline"
            className="border-primary/50 font-mono tracking-wide text-primary uppercase"
          >
            new
          </Badge>
        )}
        {turn.model && <span className="truncate">{turn.model}</span>}
        <span className="font-sans" title={absoluteTime(turn.timestamp)}>
          {relativeTime(turn.timestamp)}
        </span>
        {turn.tokens > 0 && (
          <span className="tabular-nums" title={`${exactNumber(turn.tokens)} tokens`}>
            {compactNumber(turn.tokens)} tok
          </span>
        )}
        {turn.thinkingTokens > 0 && (
          <span
            className="tabular-nums"
            title={`${exactNumber(turn.thinkingTokens)} thinking tokens`}
          >
            {compactNumber(turn.thinkingTokens)} think
          </span>
        )}
        {turn.hasImage && (
          <Badge variant="outline" className="font-mono tracking-wide uppercase">
            image
          </Badge>
        )}
        {turn.toolCalls.length > 1 && (
          <Badge variant="outline" className="font-mono tracking-wide uppercase">
            {turn.toolCalls.length} calls
          </Badge>
        )}
        <span className="ml-auto shrink-0 tabular-nums">{seq}</span>
      </header>

      {turn.text && <MessageText text={turn.text} muted={turn.kind !== "user" && turn.kind !== "assistant"} />}
      {images.length > 0 && <MessageImages sessionId={sessionId} images={images} />}
      {turn.thinkingOnly && (
        <p className="mt-3 border-l-2 border-border pl-3 text-xs text-muted-foreground italic">
          Thought for {compactNumber(turn.thinkingTokens)} tokens, then continued.
        </p>
      )}
      {silent && <p className="text-xs text-muted-foreground">No content recorded.</p>}

      {/* A lone call carries its own top margin; inside a run the container's
          gap owns the rhythm instead, so the box itself stays margin-free. */}
      {turn.toolCalls.length === 1 && turn.toolCalls[0] !== undefined && (
        <div className="mt-3">
          <ToolCallView call={turn.toolCalls[0]} onOpenAgent={onOpenAgent} />
        </div>
      )}
      {turn.toolCalls.length > 1 && <ToolRun calls={turn.toolCalls} onOpenAgent={onOpenAgent} />}
    </article>
  );
}

/**
 * Several calls made before the model spoke again, shown as one run.
 *
 * The calls stay individually expandable; only the repeated framing goes away.
 * Failures are counted in the header because a run is otherwise summarised by
 * its size alone, and "6 calls" reads the same whether or not two of them blew up.
 */
function ToolRun({
  calls,
  onOpenAgent,
}: {
  calls: ToolCall[];
  onOpenAgent: (agentId: string) => void;
}) {
  const names = [...new Set(calls.map((call) => call.name ?? "tool"))];
  const failed = calls.filter((call) => call.isError).length;
  const only = names.length === 1 ? names[0] : null;
  const label =
    only === "Bash"
      ? `Ran ${calls.length} commands`
      : only !== null
        ? `${calls.length} ${only} calls`
        : `${calls.length} tool calls`;

  return (
    // The rule on the left ties the run together without boxing it in a second
    // border, the way a per-call frame would.
    <div className="mt-3 flex flex-col gap-1 border-l-2 border-border pl-3">
      <p className="mb-1 flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
        <span className="font-mono tracking-wide">{label}</span>
        {only === null && (
          <span className="font-mono text-[0.625rem] opacity-75">{names.join(" · ")}</span>
        )}
        {failed > 0 && (
          <Badge variant="destructive" className="font-mono">
            {failed} failed
          </Badge>
        )}
      </p>
      {calls.map((call) => (
        <ToolCallView key={call.id} call={call} onOpenAgent={onOpenAgent} />
      ))}
    </div>
  );
}

/**
 * Prose, rendered as markdown and truncated the same way tool payloads are.
 *
 * The truncation is a character slice, and markdown is not character-oriented,
 * so a preview can end inside a construct: half a table, an unclosed fence, a
 * dangling `**`. The renderer copes — CommonMark closes what is left open at
 * the end of input — but the preview of a long table can render as fewer rows
 * than it has, and an odd `**` shows literally. "Show all" always resolves it,
 * which is the same trade the plain-text version made.
 */
function MessageText({ text, muted }: { text: string; muted: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > TEXT_PREVIEW;
  const shown = expanded ? text.slice(0, TEXT_MAX) : text.slice(0, TEXT_PREVIEW);

  return (
    <>
      <Markdown
        className={cn(
          "mt-3 text-sm",
          muted ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {!expanded && long ? `${shown}…` : shown}
      </Markdown>
      {long && (
        <Button
          variant="link"
          size="xs"
          className="mt-1 h-auto px-0 font-mono"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Collapse" : `Show all ${exactNumber(text.length)} characters`}
        </Button>
      )}
      {expanded && text.length > TEXT_MAX && (
        <p className="mt-1 text-xs text-muted-foreground">
          Cut off at {exactNumber(TEXT_MAX)} of {exactNumber(text.length)} characters.
        </p>
      )}
    </>
  );
}
