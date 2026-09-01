import type { Overview } from "../../src/contract.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  absoluteTime,
  agentDotClass,
  compactNumber,
  exactNumber,
  hueFor,
  relativeTime,
} from "../format.ts";

interface OverviewViewProps {
  overview: Overview;
  onSelectProject: (projectId: string) => void;
}

const sectionHeading = "text-xs font-medium tracking-wider text-muted-foreground uppercase";

/** Shown while no project is selected: what is in the index, and what is running. */
export function OverviewView({ overview, onSelectProject }: OverviewViewProps) {
  const { stats, agentTypes, live, projects } = overview;
  const maxAgents = agentTypes[0]?.count ?? 1;
  const recent = projects
    .toSorted((a, b) => (b.lastActive ?? "").localeCompare(a.lastActive ?? ""))
    .slice(0, 5);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
      <section className="flex flex-col gap-3">
        <h2 className={sectionHeading}>Index</h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Projects" value={stats.projects} />
          <Stat label="Sessions" value={stats.sessions} />
          <Stat label="Agents" value={stats.agents} />
          <Stat label="Messages" value={stats.messages} />
          <Stat label="Tool calls" value={stats.toolCalls} />
          <Stat label="Tasks" value={stats.tasks} />
        </dl>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className={sectionHeading}>Running now</h2>
        {live.length === 0 ? (
          <p className="text-xs/relaxed text-muted-foreground">
            No sessions are running right now.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {live.map((session) => (
              <li
                key={session.pid}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-card px-3 py-2 text-xs ring-1 ring-border"
              >
                <Badge className="shrink-0 gap-1 px-1.5">
                  <span
                    aria-hidden="true"
                    className="size-1.5 animate-pulse rounded-full bg-primary-foreground"
                  />
                  live
                </Badge>
                <span className={cn("truncate font-medium", session.name === null && "font-mono")}>
                  {session.name ?? session.sessionId}
                </span>
                <span className="font-mono text-muted-foreground tabular-nums">
                  pid {session.pid}
                </span>
                {session.cwd && (
                  <span className="min-w-0 truncate font-mono text-muted-foreground">
                    {session.cwd}
                  </span>
                )}
                <span
                  className="ml-auto shrink-0 text-muted-foreground"
                  title={absoluteTime(session.startedAt)}
                >
                  started {relativeTime(session.startedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className={sectionHeading}>Agent types</h2>
        {agentTypes.length === 0 ? (
          <p className="text-xs/relaxed text-muted-foreground">No subagents have been indexed.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {agentTypes.map((type) => (
              <li
                key={type.agentType}
                className="flex items-center gap-3 text-xs"
                data-hue={hueFor(type.agentType)}
              >
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    agentDotClass(hueFor(type.agentType)),
                  )}
                  aria-hidden="true"
                />
                <span className="w-44 shrink-0 truncate">{type.agentType}</span>
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-md bg-muted">
                  <i
                    aria-hidden="true"
                    className="block h-full rounded-md bg-primary"
                    style={{ width: `${(type.count / maxAgents) * 100}%` }}
                  />
                </span>
                <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                  {type.count} · depth {type.maxDepth}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className={sectionHeading}>Recently active</h2>
        <ul className="flex flex-col gap-1">
          {recent.map((project) => (
            <li key={project.id} className="flex flex-wrap items-center gap-x-2 text-xs">
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto px-0 text-xs"
                onClick={() => onSelectProject(project.id)}
              >
                {project.name}
              </Button>{" "}
              <span className="font-mono text-muted-foreground tabular-nums">
                {project.sessionCount} sessions · {compactNumber(project.messageCount)} msgs ·{" "}
                {relativeTime(project.lastActive)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * One index total. Rendered as a `<div>`-shaped card so the `dt`/`dd` pair stays
 * a direct, valid child grouping of the surrounding `<dl>`.
 */
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card size="sm" className="gap-1 px-3">
      <dt className="text-[0.625rem] tracking-wider text-muted-foreground uppercase">{label}</dt>
      <dd title={exactNumber(value)} className="font-mono text-xl font-semibold tabular-nums">
        {compactNumber(value)}
      </dd>
    </Card>
  );
}
