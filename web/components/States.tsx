import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";

/** The three states every fetching pane has to answer for, in one place. */

export function Loading({ what }: { what: string }) {
  return (
    <div className="flex flex-col gap-3 p-4" role="status" aria-busy="true">
      <p className="text-xs/relaxed text-muted-foreground">Loading {what}…</p>
      <div className="flex flex-col gap-2" aria-hidden="true">
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-2/5" />
      </div>
    </div>
  );
}

export function ErrorState({ what, message }: { what: string; message: string }) {
  return (
    <div
      className="m-4 flex items-start gap-2.5 rounded-lg bg-destructive/10 p-3 text-xs/relaxed"
      role="alert"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-1">
        <strong className="font-medium text-foreground">Could not load {what}.</strong>
        <span className="font-mono break-words text-destructive">{message}</span>
        <span className="text-muted-foreground">
          The API server may not be running — try `bun run serve`.
        </span>
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="p-4 text-xs/relaxed text-muted-foreground">{children}</p>;
}
