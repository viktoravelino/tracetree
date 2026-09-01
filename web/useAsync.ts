import { useEffect, useRef, useState, type DependencyList } from "react";

export type AsyncState<T> =
  | { status: "loading" }
  | { status: "error"; error: string }
  /** `refreshing` is true while a `keepPrevious` reload is still in flight. */
  | { status: "ready"; data: T; refreshing: boolean };

export interface AsyncOptions {
  /**
   * Keep showing the last result while the next one loads instead of dropping
   * back to `loading`. Live panes reload on every sync, and blanking a
   * transcript several times a minute is worse than showing a stale frame for
   * a few hundred milliseconds.
   *
   * Callers must be able to tell whether the kept result answers the *current*
   * deps — a paginated response carries its own `offset`/`limit`, so the
   * transcript checks those rather than trusting identity.
   */
  keepPrevious?: boolean;
}

/**
 * Runs `load` whenever `deps` change, aborting the in-flight request first.
 * Loading, error and success are all representable, so callers must handle them.
 */
export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
  options: AsyncOptions = {},
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  const loadRef = useRef(load);
  loadRef.current = load;
  const keepPrevious = options.keepPrevious ?? false;
  const keepPreviousRef = useRef(keepPrevious);
  keepPreviousRef.current = keepPrevious;

  useEffect(() => {
    const controller = new AbortController();
    setState((previous) =>
      keepPreviousRef.current && previous.status === "ready"
        ? { status: "ready", data: previous.data, refreshing: true }
        : { status: "loading" },
    );
    loadRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data, refreshing: false });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", error: describe(error) });
      },
    );
    return () => controller.abort();
    // `load` is read through a ref, so `deps` alone decides when to refetch.
  }, deps);

  return state;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
