import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api.ts";
import { OverviewView } from "./components/OverviewView.tsx";
import { ProjectList } from "./components/ProjectList.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { SessionView } from "./components/SessionView.tsx";
import { ErrorState, Loading } from "./components/States.tsx";
import { StreamStatus } from "./components/StreamStatus.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { SkillNamesProvider } from "./skills.tsx";
import {
  applySync,
  EMPTY_OVERLAY,
  freshAgentsOf,
  nextExpiry,
  pruneFresh,
  revisionOf,
} from "./liveState.ts";
import { useAsync } from "./useAsync.ts";
import { useStream, type SyncEvent } from "./useStream.ts";

/**
 * Selection lives in the URL hash, so a view of one agent's thread is a link
 * you can paste to someone else. `agent` is `""` for the main thread.
 */
interface Route {
  project: string | null;
  session: string | null;
  agent: string;
}

/**
 * How long syncs are coalesced before the project and session lists reload.
 *
 * The lists are whole-index aggregates and a busy session emits syncs every few
 * hundred milliseconds; refetching them per event would keep a 160 MB database
 * permanently busy for numbers that barely move. The session actually on screen
 * does not wait for this — it reloads on its own revision, immediately.
 */
const LIST_REFRESH_MS = 10_000;

function parseHash(hash: string): Route {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return {
    project: params.get("project"),
    session: params.get("session"),
    agent: params.get("agent") ?? "",
  };
}

function toHash(route: Route): string {
  const params = new URLSearchParams();
  if (route.project) params.set("project", route.project);
  if (route.session) params.set("session", route.session);
  if (route.agent) params.set("agent", route.agent);
  const query = params.toString();
  return query ? `#${query}` : "#";
}

const subscribeToHash = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

/** Stable identity: a fresh [] each render would rebuild the skill name set. */
const EMPTY_SKILLS: readonly string[] = [];

function App() {
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash);
  const route = useMemo(() => parseHash(hash), [hash]);
  const [refreshKey, setRefreshKey] = useState(0);

  const [overlay, setOverlay] = useState(EMPTY_OVERLAY);
  const [listRevision, setListRevision] = useState(0);
  const listTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Trailing-edge throttle: the first sync of a burst arms the timer and every
  // sync after it is absorbed, so a chatty session costs one list reload per
  // window rather than one per event.
  const scheduleListRefresh = useCallback(() => {
    if (listTimer.current !== null) return;
    listTimer.current = setTimeout(() => {
      listTimer.current = null;
      setListRevision((value) => value + 1);
    }, LIST_REFRESH_MS);
  }, []);

  const onSync = useCallback(
    (event: SyncEvent) => {
      setOverlay((previous) => applySync(previous, event));
      scheduleListRefresh();
    },
    [scheduleListRefresh],
  );

  const stream = useStream(onSync);

  useEffect(() => {
    return () => {
      if (listTimer.current !== null) clearTimeout(listTimer.current);
    };
  }, []);

  // "Just spawned" marks lapse on their own; wake up exactly when the earliest
  // one does rather than polling.
  useEffect(() => {
    const expiry = nextExpiry(overlay);
    if (expiry === null) return;
    const timer = setTimeout(
      () => setOverlay((previous) => pruneFresh(previous)),
      Math.max(0, expiry - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [overlay]);

  // One call feeds the sidebar, the header and the overview pane. `keepPrevious`
  // matters here: this reloads on a timer now, and blanking the sidebar every
  // ten seconds would be worse than showing a slightly old count.
  const overview = useAsync((signal) => api.overview(signal), [refreshKey, listRevision], {
    keepPrevious: true,
  });
  const projects = overview.status === "ready" ? overview.data.projects : [];
  const selectedProject = projects.find((project) => project.id === route.project) ?? null;

  // The stream knows liveness sooner and more accurately than the last fetch:
  // a session *ending* is not a file change, so only a heartbeat clears a badge.
  const liveSessionIds = stream.liveSessionIds;
  const liveCount =
    liveSessionIds !== null
      ? liveSessionIds.size
      : overview.status === "ready"
        ? overview.data.live.length
        : 0;
  const liveIsStale = stream.status !== "open";

  // Auto by default: the project list is for choosing, so it collapses to a rail
  // once a project is chosen. Toggling pins the choice for the rest of the visit.
  const [navPinned, setNavPinned] = useState<boolean | null>(null);
  const navExpanded = navPinned ?? route.project === null;

  // A project counts as live when a running session's cwd sits inside it, which
  // also catches a session running in one of its worktrees. Only the innermost
  // match counts: project ids are paths, and the home directory is a prefix of
  // every repo under it, so a plain prefix test marks it live for all of them.
  const liveProjectIds = useMemo(() => {
    const ids = new Set<string>();
    if (overview.status !== "ready") return ids;
    for (const session of overview.data.live) {
      const cwd = session.cwd;
      if (cwd === null) continue;
      let innermost: string | null = null;
      for (const project of overview.data.projects) {
        const inside = cwd === project.id || cwd.startsWith(`${project.id}/`);
        if (inside && (innermost === null || project.id.length > innermost.length)) {
          innermost = project.id;
        }
      }
      if (innermost !== null) ids.add(innermost);
    }
    return ids;
  }, [overview]);

  const navigate = (next: Route) => {
    window.location.hash = toHash(next);
  };

  const skillNames = overview.status === "ready" ? overview.data.skillNames : EMPTY_SKILLS;

  return (
    <SkillNamesProvider names={skillNames}>
      <TooltipProvider>
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
            <h1 className="shrink-0 text-sm font-semibold tracking-tight">tracetree</h1>
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {selectedProject ? (
                <>
                  <span className="truncate">{selectedProject.name}</span>
                  <span aria-hidden="true">/</span>
                  <span className="truncate font-mono" title={selectedProject.id}>
                    {selectedProject.id}
                  </span>
                </>
              ) : (
                <span>Claude Code transcript index</span>
              )}
            </p>

            <div className="ml-auto flex shrink-0 items-center gap-2">
              {liveCount > 0 && (
                <Badge
                  variant={liveIsStale ? "outline" : "default"}
                  className={cn("font-mono", liveIsStale && "text-muted-foreground")}
                  title={
                    liveIsStale
                      ? "Liveness is from the last load - the stream is not connected."
                      : undefined
                  }
                >
                  {liveCount} live session{liveCount === 1 ? "" : "s"}
                  {liveIsStale && <span className="ml-1 opacity-70">stale</span>}
                </Badge>
              )}
              <StreamStatus stream={stream} />
              <Button variant="ghost" size="sm" onClick={() => setRefreshKey(refreshKey + 1)}>
                Refresh
              </Button>
            </div>
          </header>

          {/* Every pane below is handed a box that is already flex/min-h-0/hidden,
            so each component owns its own scrolling rather than the page doing it. */}
          <div className="flex min-h-0 flex-1">
            <aside
              className={cn(
                "flex min-h-0 shrink-0 flex-col overflow-hidden border-r bg-sidebar text-sidebar-foreground",
                "transition-[width] duration-150",
                navExpanded ? "w-64" : "w-14",
              )}
            >
              <div
                className={cn(
                  "flex h-10 shrink-0 items-center border-b",
                  navExpanded ? "justify-between px-3" : "justify-center px-1",
                )}
              >
                {navExpanded && (
                  <h2 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
                    Projects
                  </h2>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-expanded={navExpanded}
                  aria-label={navExpanded ? "Collapse the project list" : "Expand the project list"}
                  title={navExpanded ? "Collapse the project list" : "Expand the project list"}
                  onClick={() => setNavPinned(!navExpanded)}
                >
                  {navExpanded ? (
                    <PanelLeftClose className="size-4" aria-hidden="true" />
                  ) : (
                    <PanelLeftOpen className="size-4" aria-hidden="true" />
                  )}
                </Button>
              </div>
              {overview.status === "loading" && <Loading what="projects" />}
              {overview.status === "error" && (
                <ErrorState what="projects" message={overview.error} />
              )}
              {overview.status === "ready" && (
                <ProjectList
                  projects={projects}
                  selectedId={route.project}
                  onSelect={(project) => navigate({ project, session: null, agent: "" })}
                  collapsed={!navExpanded}
                  liveProjectIds={liveProjectIds}
                />
              )}
            </aside>

            {route.project === null && route.session === null ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {overview.status === "loading" && <Loading what="the index overview" />}
                {overview.status === "error" && (
                  <ErrorState what="the index overview" message={overview.error} />
                )}
                {overview.status === "ready" && (
                  <OverviewView
                    overview={overview.data}
                    onSelectProject={(project) => navigate({ project, session: null, agent: "" })}
                  />
                )}
              </div>
            ) : (
              <>
                {route.project !== null && (
                  <div className="flex w-84 min-h-0 shrink-0 flex-col overflow-hidden border-r">
                    <SessionList
                      projectId={route.project}
                      selectedSessionId={route.session}
                      onSelect={(session) => navigate({ ...route, session, agent: "" })}
                      refreshKey={refreshKey}
                      revision={listRevision}
                      liveSessionIds={liveSessionIds}
                    />
                  </div>
                )}
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  {route.session === null ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-1 p-8 text-center">
                      <strong className="text-sm font-medium">No session selected</strong>
                      <span className="text-sm text-muted-foreground">
                        Pick a session to see its threads, tasks and transcript.
                      </span>
                    </div>
                  ) : (
                    <SessionView
                      key={route.session}
                      sessionId={route.session}
                      agentId={route.agent}
                      onSelectAgent={(agent) => navigate({ ...route, agent })}
                      refreshKey={refreshKey}
                      revision={revisionOf(overlay, route.session)}
                      freshAgentIds={freshAgentsOf(overlay, route.session)}
                      liveSessionIds={liveSessionIds}
                      onResolveProject={(project) => {
                        if (route.project === null) navigate({ ...route, project });
                      }}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </TooltipProvider>
    </SkillNamesProvider>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
