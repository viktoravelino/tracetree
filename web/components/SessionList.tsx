import { useEffect, useState } from "react";
import type { SessionSummary } from "../../src/contract.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { api } from "../api.ts";
import { compactNumber, exactNumber, relativeTime, totalTokens } from "../format.ts";
import { useAsync } from "../useAsync.ts";
import { Empty, ErrorState, Loading } from "./States.tsx";

const PAGE = 100;

interface SessionListProps {
  projectId: string;
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
  refreshKey: number;
  /** Coalesced live revision; bumped at most once per throttle window. */
  revision: number;
  /** Liveness from the stream, or `null` when the stream is not connected. */
  liveSessionIds: ReadonlySet<string> | null;
}

/** Selected rows keep a filled background and a leading rule, so hover stays readable. */
const rowClass = (active: boolean) =>
  cn(
    "flex w-full flex-col gap-1.5 rounded-md border-l-2 px-2.5 py-2 text-left",
    "transition-colors outline-none hover:bg-accent hover:text-accent-foreground",
    "focus-visible:ring-2 focus-visible:ring-ring",
    active ? "border-l-primary bg-accent text-accent-foreground" : "border-l-transparent",
  );

/** Sessions for one repository, with a title filter and a subagent-only filter. */
export function SessionList({
  projectId,
  selectedSessionId,
  onSelect,
  refreshKey,
  revision,
  liveSessionIds,
}: SessionListProps) {
  const [term, setTerm] = useState("");
  const [search, setSearch] = useState("");
  const [withAgents, setWithAgents] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  // Debounce typing so a fast typist does not queue a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(term.trim()), 250);
    return () => clearTimeout(timer);
  }, [term]);

  // Any change of scope or filter starts the list again from the first page.
  useEffect(() => setLimit(PAGE), [projectId, search, withAgents]);

  const state = useAsync(
    (signal) =>
      api.sessions(
        {
          project: projectId,
          search: search || undefined,
          withAgents: withAgents || undefined,
          limit,
        },
        signal,
      ),
    [projectId, search, withAgents, limit, refreshKey, revision],
    // This list reloads on a timer once events are flowing; keeping the rows on
    // screen avoids a full-pane flash every window.
    { keepPrevious: true },
  );

  const sessions: SessionSummary[] = state.status === "ready" ? state.data : [];
  const filtered = search !== "" || withAgents;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <h2
            id="sessions-heading"
            className="text-xs font-medium tracking-wider text-muted-foreground uppercase"
          >
            Sessions
          </h2>
          {state.status === "ready" && (
            <Badge variant="outline" className="font-mono tabular-nums">
              {sessions.length}
              {sessions.length === limit ? "+" : ""}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="sr-only" htmlFor="session-search">
            Filter sessions by title
          </label>
          <Input
            id="session-search"
            type="search"
            placeholder="Filter by title…"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            className="flex-1"
          />
          {/* `id`/`htmlFor` land on the hidden input Base UI renders beside the
              control, so the label still toggles it; `aria-labelledby` names the
              `role="checkbox"` element itself rather than waiting for Base UI's
              post-mount label lookup. */}
          <span className="flex shrink-0 items-center gap-1.5">
            <Checkbox
              id="session-with-agents"
              aria-labelledby="session-with-agents-label"
              checked={withAgents}
              onCheckedChange={(checked) => setWithAgents(checked)}
            />
            <label
              id="session-with-agents-label"
              htmlFor="session-with-agents"
              className="text-xs text-muted-foreground select-none"
            >
              subagents
            </label>
          </span>
        </div>
      </div>
      <Separator />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.status === "loading" && <Loading what="sessions" />}
        {state.status === "error" && <ErrorState what="sessions" message={state.error} />}
        {state.status === "ready" && sessions.length === 0 && (
          <Empty>
            {filtered
              ? "No sessions match these filters."
              : "No sessions indexed for this project."}
          </Empty>
        )}

        {sessions.length > 0 && (
          <ul aria-labelledby="sessions-heading" className="space-y-0.5 p-2">
            {sessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className={rowClass(session.id === selectedSessionId)}
                  aria-current={session.id === selectedSessionId}
                  onClick={() => onSelect(session.id)}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={
                        session.title
                          ? "min-w-0 flex-1 truncate text-xs font-medium"
                          : "min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground italic"
                      }
                    >
                      {session.title ?? "Untitled session"}
                    </span>
                    {(liveSessionIds !== null
                      ? liveSessionIds.has(session.id)
                      : session.isLive) && (
                      <Badge className="shrink-0 gap-1 px-1.5">
                        <span
                          aria-hidden="true"
                          className="size-1.5 animate-pulse rounded-full bg-primary-foreground"
                        />
                        live
                      </Badge>
                    )}
                  </span>
                  <span className="flex flex-wrap items-center gap-1">
                    {session.gitBranch && (
                      <Badge variant="outline" className="max-w-full font-mono" title="git branch">
                        <span className="truncate">{session.gitBranch}</span>
                      </Badge>
                    )}
                    {session.worktree && (
                      <Badge variant="secondary" title={session.worktree}>
                        worktree
                      </Badge>
                    )}
                    {session.agentCount > 0 && (
                      <Badge variant="secondary">
                        {session.agentCount} agent{session.agentCount === 1 ? "" : "s"}
                      </Badge>
                    )}
                  </span>
                  <span className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[0.625rem] text-muted-foreground tabular-nums">
                    <span
                      className="font-mono"
                      title={`${exactNumber(session.messageCount)} messages`}
                    >
                      {compactNumber(session.messageCount)} msgs
                    </span>
                    <span
                      className="font-mono"
                      title={`${exactNumber(totalTokens(session.tokens))} tokens`}
                    >
                      {compactNumber(totalTokens(session.tokens))} tok
                    </span>
                    <span className="ml-auto" title={session.startedAt ?? "unknown start"}>
                      {relativeTime(session.startedAt)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {sessions.length === limit && (
              <li className="pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => setLimit(limit + PAGE)}
                >
                  Load {PAGE} more
                </Button>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
