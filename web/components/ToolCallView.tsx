import { useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import type { ToolCall } from "../../src/contract.ts";
import { exactNumber } from "../format.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** Characters shown before a blob is collapsed. */
const PREVIEW = 700;
/** Hard ceiling on what ever reaches the DOM, however far you expand. */
const MAX_RENDER = 40_000;

/** Fields worth putting in the collapsed headline, in order of usefulness. */
const HEADLINE_FIELDS = [
  "command",
  // Which skill ran; without it a Skill call headlines as its own parameter
  // names, since none of the fields below appear in its input.
  "skill",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
] as const;

interface ToolCallViewProps {
  call: ToolCall;
  /** Offered on `Agent` calls whose subagent is part of this session. */
  onOpenAgent?: (agentId: string) => void;
}

/**
 * One tool call, collapsed to a single line by default. Bodies are only built
 * when opened and are truncated on the way in, so a 4 MB Bash result never
 * lands in the DOM whole.
 *
 * The `open &&` guard inside the panel is not decoration: Base UI unmounts a
 * closed panel, but the children of `<CollapsibleContent>` are still *created*
 * on every render, which would run `toText` — a JSON.stringify of an arbitrary
 * payload — for every collapsed call on the page. The guard keeps that cost,
 * and the string it produces, out of a closed call entirely.
 */
export function ToolCallView({ call, onOpenAgent }: ToolCallViewProps) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-error={call.isError}
      className={cn(
        "overflow-hidden rounded-md border border-border bg-card",
        call.isError && "border-destructive/40",
      )}
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs",
          "text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
      >
        {open ? (
          <ChevronDownIcon className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        )}
        <span className="shrink-0 font-semibold text-foreground">{call.name ?? "tool"}</span>
        {call.isError && (
          <Badge variant="destructive" className="shrink-0 font-mono">
            error
          </Badge>
        )}
        <span className="min-w-0 flex-1 truncate opacity-80">{headline(call.input)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {open && (
          <div className="border-t border-border px-2.5 pt-2.5 pb-3">
            {call.spawnedAgentId && onOpenAgent && (
              <p className="mb-1.5">
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto px-0 font-mono"
                  onClick={() => onOpenAgent(call.spawnedAgentId ?? "")}
                >
                  Open the spawned agent&rsquo;s thread &rarr;
                </Button>
              </p>
            )}
            <BodyHeading>Input</BodyHeading>
            <Blob text={toText(call.input)} command={commandOf(call)} />
            <BodyHeading destructive={call.isError}>
              {call.isError ? "Error" : "Result"}
            </BodyHeading>
            <Blob text={toText(call.result)} />
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function BodyHeading({
  children,
  destructive = false,
}: {
  children: ReactNode;
  destructive?: boolean;
}) {
  return (
    <h4
      className={cn(
        "mt-1.5 mb-1 text-[0.625rem] font-medium tracking-wider uppercase first:mt-0",
        destructive ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </h4>
  );
}

/** A `pre` that starts truncated and can never render more than MAX_RENDER. */
function Blob({ text, command }: { text: string; command?: string | null }) {
  const [expanded, setExpanded] = useState(false);

  if (text === "") return <p className="text-xs text-muted-foreground">empty</p>;

  const long = text.length > PREVIEW;
  const shown = expanded ? text.slice(0, MAX_RENDER) : text.slice(0, PREVIEW);
  const clipped = expanded && text.length > MAX_RENDER;

  return (
    <>
      {command !== undefined && command !== null && (
        <pre className={cn(BLOB_CLASS, "mb-1 text-foreground")}>
          {command.slice(0, MAX_RENDER)}
        </pre>
      )}
      <pre className={BLOB_CLASS}>
        {shown}
        {!expanded && long ? "…" : ""}
      </pre>
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
      {clipped && (
        <p className="mt-1 text-xs text-muted-foreground">
          Cut off at {exactNumber(MAX_RENDER)} of {exactNumber(text.length)} characters.
        </p>
      )}
    </>
  );
}

/**
 * Payload styling. The height cap plus `overflow-auto` is deliberate: a 40,000
 * character result is bounded here rather than stretching the transcript, and
 * React's `onScroll` does not bubble, so this inner scroller cannot be mistaken
 * for the transcript's own by the follow-mode handler.
 */
const BLOB_CLASS =
  "m-0 max-h-[460px] overflow-auto rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[0.6875rem] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground";

/** Bash dominates the index, so its command gets its own line above the input. */
function commandOf(call: ToolCall): string | null {
  if (call.name !== "Bash") return null;
  return readString(call.input, "command");
}

function headline(input: unknown): string {
  if (typeof input === "string") return firstLine(input);
  if (!isRecord(input)) return "";
  for (const field of HEADLINE_FIELDS) {
    const value = readString(input, field);
    if (value) return firstLine(value);
  }
  return Object.keys(input).join(", ");
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function readString(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tool payloads are arbitrary JSON; strings pass through, everything else prints. */
export function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
