import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * The skill names the index has seen, shared with anything rendering prose.
 *
 * A context rather than props: the only consumer is deep inside the markdown
 * renderer, which is reached through the session view, the transcript and a
 * turn, none of which have any other reason to know about skills.
 */
const SkillNamesContext = createContext<ReadonlySet<string>>(new Set());

export function SkillNamesProvider({
  names,
  children,
}: {
  names: readonly string[];
  children: ReactNode;
}) {
  const value = useMemo(() => new Set(names), [names]);
  return <SkillNamesContext.Provider value={value}>{children}</SkillNamesContext.Provider>;
}

export function useSkillNames(): ReadonlySet<string> {
  return useContext(SkillNamesContext);
}
