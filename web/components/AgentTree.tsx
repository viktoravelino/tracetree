import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, Waypoints } from "lucide-react";

import type { AgentNode } from "../../src/contract.ts";
import {
  agentDotClass,
  compactNumber,
  duration,
  exactNumber,
  hueFor,
  totalTokens,
} from "../format.ts";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** The main thread is addressed as `""` everywhere in the contract. */
export const MAIN_THREAD = "";

const NO_FRESH_AGENTS: ReadonlySet<string> = new Set<string>();

interface AgentTreeProps {
  agents: AgentNode[];
  /** Messages belonging to the main thread itself, not the whole session. */
  mainThreadMessages: number;
  selectedAgentId: string;
  onSelect: (agentId: string) => void;
  /** Subagents the stream just announced; marked until the flag lapses. */
  freshAgentIds?: ReadonlySet<string>;
}

interface Row {
  id: string;
  /** `null` on the synthetic root that stands for the main thread. */
  node: AgentNode | null;
  level: number;
  parentId: string | null;
  childIds: string[];
  messages: number;
}

/**
 * Spawn tree for a session: the main thread is the root, and every subagent
 * hangs beneath the thread that spawned it. Selecting a node switches the
 * transcript to that thread. Follows the APG tree keyboard pattern.
 */
export function AgentTree({
  agents,
  mainThreadMessages,
  selectedAgentId,
  onSelect,
  freshAgentIds = NO_FRESH_AGENTS,
}: AgentTreeProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [focusedId, setFocusedId] = useState<string>(MAIN_THREAD);
  const items = useRef(new Map<string, HTMLLIElement>());

  const rows = useMemo(
    () => flatten(agents, mainThreadMessages, collapsed),
    [agents, mainThreadMessages, collapsed],
  );

  const focus = (id: string) => {
    setFocusedId(id);
    items.current.get(id)?.focus();
  };

  const setExpanded = (id: string, open: boolean) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const index = rows.findIndex((row) => row.id === focusedId);
    const row = index < 0 ? undefined : rows[index];
    if (!row) return;
    const open = row.childIds.length > 0 && !collapsed.has(row.id);

    switch (event.key) {
      case "ArrowDown":
        step(rows, index + 1, focus);
        break;
      case "ArrowUp":
        step(rows, index - 1, focus);
        break;
      case "Home":
        step(rows, 0, focus);
        break;
      case "End":
        step(rows, rows.length - 1, focus);
        break;
      case "ArrowRight":
        if (row.childIds.length === 0) return;
        if (open) step(rows, index + 1, focus);
        else setExpanded(row.id, true);
        break;
      case "ArrowLeft":
        if (open) setExpanded(row.id, false);
        else if (row.parentId !== null) focus(row.parentId);
        else return;
        break;
      case "Enter":
      case " ":
        onSelect(row.id);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const renderLevel = (parentId: string | null) =>
    rows
      .filter((row) => row.parentId === parentId)
      .map((row) => {
        const open = row.childIds.length > 0 && !collapsed.has(row.id);
        const selected = row.id === selectedAgentId;
        const fresh = row.node !== null && freshAgentIds.has(row.id);
        return (
          <li
            key={row.id || "main"}
            role="treeitem"
            aria-selected={selected}
            aria-level={row.level + 1}
            aria-label={fresh ? `${labelFor(row)} — just spawned` : labelFor(row)}
            aria-expanded={row.childIds.length > 0 ? open : undefined}
            tabIndex={row.id === focusedId ? 0 : -1}
            // The elbow: a hairline from the parent's rail into this row. Only
            // nested rows get one — the main thread has no rail to hang off.
            className={cn(
              "group/node relative cursor-pointer outline-none",
              row.level > 0 &&
                "before:absolute before:top-[0.9375rem] before:-left-3 before:h-px before:w-3 before:bg-border",
            )}
            ref={(element) => {
              if (element) items.current.set(row.id, element);
              else items.current.delete(row.id);
            }}
            onFocus={(event) => {
              if (event.target === event.currentTarget) setFocusedId(row.id);
            }}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(row.id);
              focus(row.id);
              if (row.childIds.length > 0) setExpanded(row.id, true);
            }}
          >
            <NodeRow row={row} open={open} selected={selected} fresh={fresh} />
            {open && (
              // The rail: one vertical line per group, so depth is readable at
              // a glance and every child of a thread lines up under it.
              <ul
                role="group"
                className="mt-1 ml-3 flex flex-col gap-1 border-l border-border pl-3"
              >
                {renderLevel(row.id)}
              </ul>
            )}
          </li>
        );
      });

  return (
    <div className="text-xs/relaxed">
      <ul
        role="tree"
        aria-label="Session threads"
        className="flex flex-col gap-1"
        onKeyDown={onKeyDown}
      >
        {renderLevel(null)}
      </ul>
    </div>
  );
}

function NodeRow({
  row,
  open,
  selected,
  fresh,
}: {
  row: Row;
  open: boolean;
  selected: boolean;
  /** True while this subagent counts as "just spawned". */
  fresh: boolean;
}) {
  const { node } = row;
  const type = node ? (node.agentType ?? "unknown type") : "Main thread";
  // A node with no description falls back to its type, so the row still reads as
  // something rather than leaving the primary line blank.
  const title = node ? (node.description ?? type) : type;
  const span = node ? duration(node.startedAt, node.endedAt) : null;
  const hue = node ? hueFor(node.agentType) : undefined;

  return (
    <span
      className={cn(
        "flex flex-col gap-1 rounded-md border border-transparent px-2 py-1.5 transition-colors",
        "hover:bg-accent",
        "group-focus-visible/node:border-ring group-focus-visible/node:ring-2 group-focus-visible/node:ring-ring/30",
        selected && "border-border bg-accent text-accent-foreground",
        fresh && "border-primary",
      )}
      data-hue={hue}
      data-new={fresh ? "true" : undefined}
    >
      <span className="flex items-center gap-2">
        <span
          className="flex size-3 shrink-0 items-center justify-center text-muted-foreground"
          aria-hidden="true"
        >
          {row.childIds.length > 0 ? (
            open ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )
          ) : null}
        </span>
        {node ? (
          <span
            className={cn("size-2 shrink-0 rounded-full", agentDotClass(hue))}
            aria-hidden="true"
          />
        ) : (
          <Waypoints className="size-3 shrink-0 text-primary" aria-hidden="true" />
        )}
        {/* What the agent was asked to do leads; its type is a qualifier, and
            the same type repeats down the whole tree so it carries little. */}
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-medium",
            !node && "text-foreground",
            node && !node.description && "text-muted-foreground italic",
          )}
          title={title}
        >
          {title}
        </span>
        {node && node.description !== null && (
          <span
            className="shrink-0 truncate font-mono text-[0.625rem] text-muted-foreground"
            title={`agent type: ${type}`}
          >
            {type}
          </span>
        )}
        {fresh && <Badge className="shrink-0">new</Badge>}
      </span>
      <span className="flex flex-wrap items-center gap-x-2 pl-[1.375rem] font-mono text-[0.625rem] text-muted-foreground tabular-nums">
        <span title={`${exactNumber(row.messages)} messages`}>
          {compactNumber(row.messages)} msgs
        </span>
        {node && (
          <span title={`${exactNumber(totalTokens(node.tokens))} tokens`}>
            {compactNumber(totalTokens(node.tokens))} tok
          </span>
        )}
        {span && <span>{span}</span>}
      </span>
    </span>
  );
}

/** Visible rows in render order; collapsed subtrees are omitted entirely. */
function flatten(
  agents: AgentNode[],
  mainThreadMessages: number,
  collapsed: ReadonlySet<string>,
): Row[] {
  const rows: Row[] = [
    {
      id: MAIN_THREAD,
      node: null,
      level: 0,
      parentId: null,
      childIds: agents.map((agent) => agent.agentId),
      messages: mainThreadMessages,
    },
  ];

  const walk = (nodes: AgentNode[], level: number, parentId: string) => {
    for (const node of nodes) {
      rows.push({
        id: node.agentId,
        node,
        level,
        parentId,
        childIds: node.children.map((child) => child.agentId),
        messages: node.messageCount,
      });
      if (node.children.length > 0 && !collapsed.has(node.agentId)) {
        walk(node.children, level + 1, node.agentId);
      }
    }
  };

  if (!collapsed.has(MAIN_THREAD)) walk(agents, 1, MAIN_THREAD);
  return rows;
}

/** Reads in the order the row does: what it was asked to do, then its type. */
function labelFor(row: Row): string {
  if (!row.node) return "Main thread";
  const type = row.node.agentType ?? "unknown type";
  return row.node.description ? `${row.node.description} (${type})` : type;
}

function step(rows: Row[], index: number, focus: (id: string) => void) {
  const row = rows[index];
  if (row) focus(row.id);
}
