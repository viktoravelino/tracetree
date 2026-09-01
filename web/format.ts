import type { TokenCounts } from "../src/contract.ts";

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const EXACT = new Intl.NumberFormat("en");

const UNITS = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1_000],
] as const;

/** "3 days ago" / "in 2 hours"; `null` and unparseable stamps read as "never". */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  const at = parseTime(iso);
  if (at === null) return "never";
  const delta = at - now;
  const magnitude = Math.abs(delta);
  for (const [unit, ms] of UNITS) {
    if (magnitude >= ms) return RELATIVE.format(Math.round(delta / ms), unit);
  }
  return "just now";
}

export function absoluteTime(iso: string | null): string {
  const at = parseTime(iso);
  if (at === null) return "unknown";
  return new Date(at).toLocaleString();
}

/** Wall-clock span between two stamps, e.g. "4m 12s"; `null` when unknowable. */
export function duration(startIso: string | null, endIso: string | null): string | null {
  const start = parseTime(startIso);
  const end = parseTime(endIso);
  if (start === null || end === null || end < start) return null;
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function parseTime(iso: string | null): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

export const compactNumber = (value: number): string => COMPACT.format(value);
export const exactNumber = (value: number): string => EXACT.format(value);

export const totalTokens = (tokens: TokenCounts): number =>
  tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;

// Matches the theme's chart tokens exactly (--chart-1 … --chart-5), so every
// agent type lands on a real palette colour rather than borrowing a neutral.
export const HUE_COUNT = 5;

/**
 * Stable colour slot for an agent type, so the same type keeps its hue across
 * every view. Unknown types fall back to the neutral slot (-1 -> no `data-hue`).
 */
export function hueFor(key: string | null): number | undefined {
  if (!key) return undefined;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash % HUE_COUNT;
}

/**
 * Dot colour for an agent type's hue slot, one per chart token so the same type
 * reads the same in the tree and in the overview. Unknown types stay neutral.
 */
const HUE_DOTS = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"] as const;

export function agentDotClass(hue: number | undefined): string {
  if (hue === undefined) return "bg-muted-foreground";
  return HUE_DOTS[hue % HUE_DOTS.length] ?? "bg-muted-foreground";
}

/**
 * Two-character stand-in for a project, for the collapsed rail.
 *
 * Prefers the initials of the first two words so sibling repos stay
 * distinguishable ("web-client" -> WC, not WE), and falls back to the
 * first two letters when there is only one word.
 */
export function initialsFor(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const first = parts[0];
  if (first === undefined) return "?";
  const second = parts[1];
  return (second === undefined ? first.slice(0, 2) : first[0]! + second[0]!).toUpperCase();
}

/** Trailing path segment, for turning a repo path into a readable name. */
export function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
