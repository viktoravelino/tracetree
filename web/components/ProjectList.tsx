import { LayoutGrid } from "lucide-react";

import type { Project } from "../../src/contract.ts";
import { cn } from "@/lib/utils";
import { compactNumber, exactNumber, initialsFor, relativeTime } from "../format.ts";

interface ProjectListProps {
  projects: Project[];
  selectedId: string | null;
  onSelect: (projectId: string | null) => void;
  /** Narrow rail: initials only, for when a project is already chosen. */
  collapsed?: boolean;
  /** Projects with a session running right now, marked with a dot. */
  liveProjectIds?: ReadonlySet<string>;
}

/**
 * Shared shape for every sidebar row. The selected row keeps a filled
 * background plus a leading rule so it stays distinguishable from hover.
 */
const rowClass = (active: boolean) =>
  cn(
    "flex w-full flex-col gap-1 rounded-md border-l-2 px-2.5 py-2 text-left text-xs",
    "transition-colors outline-none",
    "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
    "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
    active
      ? "border-l-sidebar-primary bg-sidebar-accent text-sidebar-accent-foreground"
      : "border-l-transparent text-sidebar-foreground",
  );

/**
 * Collapsed rail row. The name is carried entirely by `aria-label` and `title`,
 * since two letters are a visual shorthand and not an accessible name.
 */
const railClass = (active: boolean) =>
  cn(
    "relative flex size-9 items-center justify-center rounded-md font-mono text-[0.6875rem] font-medium",
    "transition-colors outline-none",
    "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
    "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
    active
      ? "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-sidebar-primary"
      : "text-muted-foreground",
  );

/** Sidebar of repositories. The first row clears the selection back to the overview. */
export function ProjectList({
  projects,
  selectedId,
  onSelect,
  collapsed = false,
  liveProjectIds,
}: ProjectListProps) {
  if (collapsed) {
    return (
      <nav aria-label="Projects" className="flex h-full min-h-0 flex-1 flex-col">
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-1.5 py-2">
          <li>
            <button
              type="button"
              className={railClass(selectedId === null)}
              aria-current={selectedId === null}
              onClick={() => onSelect(null)}
              title="All projects - index overview"
              aria-label="All projects"
            >
              <LayoutGrid className="size-4" aria-hidden="true" />
            </button>
          </li>
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className={railClass(project.id === selectedId)}
                aria-current={project.id === selectedId}
                onClick={() => onSelect(project.id)}
                title={`${project.name} - ${project.id}`}
                aria-label={project.name}
              >
                {initialsFor(project.name)}
                {liveProjectIds?.has(project.id) && (
                  <span
                    className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
                    aria-hidden="true"
                  />
                )}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    );
  }

  return (
    <nav aria-label="Projects" className="flex h-full min-h-0 flex-1 flex-col">
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        <li>
          <button
            type="button"
            className={rowClass(selectedId === null)}
            aria-current={selectedId === null}
            onClick={() => onSelect(null)}
          >
            <span className="flex items-baseline justify-between gap-2">
              <strong className="truncate font-medium">All projects</strong>
              <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground tabular-nums">
                {projects.length}
              </span>
            </span>
            <span className="flex text-[0.625rem] text-muted-foreground">
              <span>index overview</span>
            </span>
          </button>
        </li>
        {projects.map((project) => (
          <li key={project.id}>
            <button
              type="button"
              className={rowClass(project.id === selectedId)}
              aria-current={project.id === selectedId}
              onClick={() => onSelect(project.id)}
            >
              <span className="flex items-baseline justify-between gap-2">
                <strong className="truncate font-medium">{project.name}</strong>
                <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground tabular-nums">
                  {relativeTime(project.lastActive)}
                </span>
              </span>
              <span
                className="block truncate font-mono text-[0.625rem] text-muted-foreground"
                title={project.id}
              >
                <bdi>{project.id}</bdi>
              </span>
              <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-[0.625rem] text-muted-foreground tabular-nums">
                <span>
                  <span className="text-muted-foreground/70">sess</span>{" "}
                  <span className="font-mono text-foreground">{project.sessionCount}</span>
                </span>
                <span>
                  <span className="text-muted-foreground/70">agents</span>{" "}
                  <span className="font-mono text-foreground">{project.agentCount}</span>
                </span>
                <span title={`${exactNumber(project.messageCount)} messages`}>
                  <span className="text-muted-foreground/70">msgs</span>{" "}
                  <span className="font-mono text-foreground">
                    {compactNumber(project.messageCount)}
                  </span>
                </span>
                {project.worktreeCount > 0 && (
                  <span>
                    <span className="text-muted-foreground/70">wt</span>{" "}
                    <span className="font-mono text-foreground">{project.worktreeCount}</span>
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
