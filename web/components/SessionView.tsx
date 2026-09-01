import { useEffect, useRef } from "react";
import { Clock, FolderGit2, GitBranch, Hash, MessageSquare, Waypoints } from "lucide-react";

import type { AgentNode, SessionDetail, ToolSummary } from "../../src/contract.ts";
import { api } from "../api.ts";
import {
  agentDotClass,
  absoluteTime,
  compactNumber,
  duration,
  exactNumber,
  hueFor,
  totalTokens,
} from "../format.ts";
import { useAsync } from "../useAsync.ts";
import { AgentTree, MAIN_THREAD } from "./AgentTree.tsx";
import { ErrorState, Loading } from "./States.tsx";
import { Transcript } from "./Transcript.tsx";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress, ProgressLabel } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

interface SessionViewProps {
  sessionId: string;
  agentId: string;
  onSelectAgent: (agentId: string) => void;
  refreshKey: number;
  /** Bumped when a `sync` names this session; the only reason to reload it. */
  revision: number;
  /** Subagents this session just spawned, flagged in the tree while fresh. */
  freshAgentIds: ReadonlySet<string>;
  /** Liveness from the stream, or `null` when the stream is not connected. */
  liveSessionIds: ReadonlySet<string> | null;
  /** Fires once the session is loaded, so a bare session link can learn its project. */
  onResolveProject?: (projectId: string) => void;
}

/** Session header, its spawn tree and rollups, and the transcript of one thread. */
export function SessionView({
  sessionId,
  agentId,
  onSelectAgent,
  refreshKey,
  revision,
  freshAgentIds,
  liveSessionIds,
  onResolveProject,
}: SessionViewProps) {
  // `revision` is what makes this surgical: only the session named by a sync
  // reloads, and `keepPrevious` keeps the tree and rollups on screen while it
  // does, so a live session does not flash "Loading session…" every few seconds.
  const state = useAsync(
    (signal) => api.session(sessionId, signal),
    [sessionId, refreshKey, revision],
    {
      keepPrevious: true,
    },
  );

  // Announce the owning project once, not on every render: the callback is an
  // inline closure upstream, so its identity alone would re-fire the effect.
  const resolvedProjectId = state.status === "ready" ? state.data.projectId : null;
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (resolvedProjectId !== null && announced.current !== resolvedProjectId) {
      announced.current = resolvedProjectId;
      onResolveProject?.(resolvedProjectId);
    }
  }, [resolvedProjectId, onResolveProject]);

  if (state.status === "loading") return <Loading what="session" />;
  if (state.status === "error") return <ErrorState what="session" message={state.error} />;

  const session = state.data;
  // The stream is the fresher source once connected; a session that ended is
  // not a file change, so only a heartbeat can clear the badge.
  const isLive = liveSessionIds !== null ? liveSessionIds.has(session.id) : session.isLive;
  const active = agentId === MAIN_THREAD ? null : findAgent(session.agents, agentId);
  const effectiveAgentId = agentId === MAIN_THREAD || active ? agentId : MAIN_THREAD;
  const agentMessages = sumMessages(session.agents);
  const mainThreadMessages = Math.max(0, session.messageCount - agentMessages);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SessionHeader session={session} isLive={isLive} />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Scrolls as one column. Its cards must not shrink: Card clips its own
            overflow, so a compressed card hides content instead of growing this
            box, and the scrollbar would never appear. */}
        <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border p-3">
          <Card size="sm" className="shrink-0">
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                Threads
                <Badge variant="outline" className="font-mono">
                  {session.agentCount} agent{session.agentCount === 1 ? "" : "s"}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <AgentTree
                agents={session.agents}
                mainThreadMessages={mainThreadMessages}
                selectedAgentId={effectiveAgentId}
                onSelect={onSelectAgent}
                freshAgentIds={freshAgentIds}
              />
              {session.agents.length === 0 && (
                <p className="text-xs/relaxed text-muted-foreground">
                  No subagents were spawned — the whole session ran on the main thread.
                </p>
              )}
            </CardContent>
          </Card>

          <Card size="sm" className="shrink-0">
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                Tasks
                <Badge variant="outline" className="font-mono">
                  {session.tasks.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {session.tasks.length === 0 ? (
                <p className="text-xs/relaxed text-muted-foreground">No tasks recorded.</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {session.tasks.map((task) => (
                    <li key={task.id} className="flex items-start gap-2">
                      <Badge
                        variant={statusVariant(task.status)}
                        className="shrink-0"
                        render={<span data-status={task.status ?? "unknown"} />}
                      >
                        {task.status ?? "—"}
                      </Badge>
                      <span className="min-w-0 flex-1 text-xs/relaxed text-foreground">
                        {task.subject ?? task.activeForm ?? task.description ?? "Untitled task"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card size="sm" className="shrink-0">
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                Tool usage
                <Badge variant="outline" className="font-mono">
                  {exactNumber(sumCalls(session.tools))} calls
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {session.tools.length === 0 ? (
                <p className="text-xs/relaxed text-muted-foreground">No tool calls recorded.</p>
              ) : (
                <ToolBars tools={session.tools} />
              )}
            </CardContent>
          </Card>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <Transcript
            // Remounting per thread keeps follow mode, the page and the "new"
            // marks from leaking across threads.
            key={`${session.id}:${effectiveAgentId}`}
            sessionId={session.id}
            agentId={effectiveAgentId}
            refreshKey={refreshKey}
            revision={revision}
            live={isLive}
            onOpenAgent={onSelectAgent}
            threadLabel={
              active ? (
                <>
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      agentDotClass(hueFor(active.agentType)),
                    )}
                    data-hue={hueFor(active.agentType)}
                    aria-hidden="true"
                  />
                  <span className="font-medium">{active.agentType ?? "unknown type"}</span>
                  <span className="truncate text-muted-foreground">
                    {active.description ?? "no description recorded"}
                  </span>
                </>
              ) : (
                <>
                  <Waypoints className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                  <span className="font-medium">Main thread</span>
                </>
              )
            }
          />
        </div>
      </div>
    </div>
  );
}

function SessionHeader({ session, isLive }: { session: SessionDetail; isLive: boolean }) {
  const span = duration(session.startedAt, session.endedAt);
  const tokens = session.tokens;

  return (
    <header className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3">
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <span className="truncate">
          {session.title ?? <span className="text-muted-foreground italic">Untitled session</span>}
        </span>
        {isLive && (
          <Badge className="shrink-0 gap-1">
            <span
              className="size-1.5 animate-pulse rounded-full bg-primary-foreground"
              aria-hidden="true"
            />
            live
          </Badge>
        )}
      </h2>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem]/relaxed text-muted-foreground">
        <span className="font-mono" title="session id">
          {session.id}
        </span>
        {session.gitBranch && (
          <Badge variant="outline" className="font-mono">
            <GitBranch aria-hidden="true" />
            {session.gitBranch}
          </Badge>
        )}
        {session.worktree && (
          <Badge variant="secondary" title={session.worktree}>
            <FolderGit2 aria-hidden="true" />
            worktree
          </Badge>
        )}
        {session.cwd && (
          <span className="truncate font-mono" title="working directory">
            {session.cwd}
          </span>
        )}
        <span className="inline-flex items-center gap-1" title={absoluteTime(session.startedAt)}>
          <Clock className="size-3" aria-hidden="true" />
          started {absoluteTime(session.startedAt)}
        </span>
        {span && <span className="font-mono">ran {span}</span>}
        <span
          className="inline-flex items-center gap-1 font-mono tabular-nums"
          title={`${exactNumber(session.messageCount)} messages in the whole tree`}
        >
          <MessageSquare className="size-3" aria-hidden="true" />
          {compactNumber(session.messageCount)} msgs
        </span>
        <span
          className="inline-flex items-center gap-1 font-mono tabular-nums"
          title={`input ${exactNumber(tokens.input)} · output ${exactNumber(tokens.output)} · cache read ${exactNumber(tokens.cacheRead)} · cache write ${exactNumber(tokens.cacheCreation)}`}
        >
          <Hash className="size-3" aria-hidden="true" />
          {compactNumber(totalTokens(tokens))} tok
        </span>
      </div>
    </header>
  );
}

/** Which badge tone a todo status reads as; anything unknown stays neutral. */
function statusVariant(status: string | null) {
  switch (status) {
    case "completed":
      return "default" as const;
    case "in_progress":
      return "secondary" as const;
    case "pending":
      return "outline" as const;
    default:
      return "ghost" as const;
  }
}

function ToolBars({ tools }: { tools: ToolSummary[] }) {
  const sorted = tools.toSorted((a, b) => b.count - a.count);
  const max = sorted[0]?.count ?? 1;

  return (
    <ul className="flex flex-col gap-2.5">
      {sorted.map((tool) => (
        <li key={tool.name}>
          <Progress value={Math.round((tool.count / max) * 100)} className="gap-x-2 gap-y-1">
            <ProgressLabel className="min-w-0 truncate font-mono text-xs/relaxed">
              {tool.name}
            </ProgressLabel>
            {tool.errors > 0 && (
              <Badge variant="destructive" className="font-mono" title={`${tool.errors} failed`}>
                {tool.errors}
              </Badge>
            )}
            <span className="ml-auto font-mono text-[0.625rem] text-muted-foreground tabular-nums">
              {exactNumber(tool.count)}
            </span>
          </Progress>
        </li>
      ))}
    </ul>
  );
}

function findAgent(nodes: AgentNode[], agentId: string): AgentNode | null {
  for (const node of nodes) {
    if (node.agentId === agentId) return node;
    const found = findAgent(node.children, agentId);
    if (found) return found;
  }
  return null;
}

function sumMessages(nodes: AgentNode[]): number {
  return nodes.reduce((total, node) => total + node.messageCount + sumMessages(node.children), 0);
}

function sumCalls(tools: ToolSummary[]): number {
  return tools.reduce((total, tool) => total + tool.count, 0);
}
