import { LoaderCircle, RefreshCw, Wifi, WifiOff, type LucideIcon } from "lucide-react";

import { backoffDelayMs, type StreamState } from "../useStream.ts";
import { relativeTime } from "../format.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Honest state of the live connection.
 *
 * The dashboard looks identical whether events are flowing or the stream died
 * ten minutes ago, so this is the only thing standing between the user and
 * silently stale data. It says which of the four states we are in, and offers
 * a way out of a backoff without reloading the page.
 */
export function StreamStatus({ stream }: { stream: StreamState }) {
  const label = LABELS[stream.status];
  const canRetry = stream.status === "reconnecting" || stream.status === "unavailable";
  const Icon = ICONS[stream.status];

  return (
    <span className="inline-flex items-center gap-1.5" data-status={stream.status}>
      <Badge variant={VARIANTS[stream.status]} className="gap-1.5">
        <Icon className={cn(stream.status === "connecting" && "animate-spin")} aria-hidden="true" />
        <span role="status">
          {label}
          {stream.status === "reconnecting" && stream.attempt > 0 && (
            <span className="ml-1 font-mono tabular-nums opacity-70"> retry {stream.attempt}</span>
          )}
        </span>
      </Badge>
      {canRetry && (
        <Button type="button" variant="ghost" size="xs" onClick={stream.retryNow}>
          Retry
        </Button>
      )}
      <span className="sr-only">{sentence(stream)}</span>
    </span>
  );
}

const LABELS: Record<StreamState["status"], string> = {
  connecting: "stream connecting",
  open: "stream live",
  reconnecting: "stream reconnecting",
  unavailable: "stream unavailable",
};

const ICONS: Record<StreamState["status"], LucideIcon> = {
  connecting: LoaderCircle,
  open: Wifi,
  reconnecting: RefreshCw,
  unavailable: WifiOff,
};

/** Badge tone per state: live reads as primary, a dead stream as destructive. */
const VARIANTS = {
  connecting: "outline",
  open: "default",
  reconnecting: "secondary",
  unavailable: "destructive",
} as const satisfies Record<StreamState["status"], string>;

/** A fuller sentence for screen readers, where a two-word pill is not enough. */
function sentence(stream: StreamState): string {
  const seen =
    stream.lastEventAt === null
      ? "no events yet"
      : `last event ${relativeTime(stream.lastEventAt)}`;
  switch (stream.status) {
    case "open":
      return `Live updates connected, ${seen}.`;
    case "connecting":
      return "Connecting to live updates.";
    case "reconnecting":
      return `Live updates dropped, ${seen}. Retrying in about ${Math.round(backoffDelayMs(stream.attempt) / 1000)} seconds.`;
    case "unavailable":
      return `Live updates unavailable — this server may not serve /api/stream. Retrying in about ${Math.round(backoffDelayMs(stream.attempt) / 1000)} seconds. Data on screen is from the last manual load.`;
  }
}
