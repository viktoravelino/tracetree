import { Children, cloneElement, isValidElement, memo, type ReactNode } from "react";
import { BoxIcon } from "lucide-react";

import { useSkillNames } from "../skills.tsx";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

/**
 * Markdown for transcript prose.
 *
 * Assistant and user messages are markdown, and the parts that matter most —
 * tables, headings, fenced code — are exactly the parts that are unreadable as
 * literal text. A GFM table rendered as text is a wall of pipes.
 *
 * Three deliberate choices:
 *
 * `remark-breaks`, because chat prose treats a single newline as a line break.
 * Without it CommonMark folds those newlines into spaces and a message written
 * as short lines renders as one run-on paragraph.
 *
 * `rehype-sanitize` with the default (GitHub) schema, unmodified. There is no
 * `rehype-raw` here on purpose: raw HTML in the source is never parsed, so the
 * only nodes reaching the sanitizer are the ones remark itself produced. The
 * schema is therefore a second line of defence rather than the only one, and
 * widening it could only weaken that. It is what neutralises a `javascript:`
 * href, drops `style` (and with it GFM's column alignment, an accepted loss),
 * and forbids `script` and every event-handler attribute.
 *
 * Memoised on the source string. The transcript refetches its whole page on
 * every server-sent update, so every visible message re-renders several times a
 * second during a live session; without this each one would be re-parsed.
 */

// Module-level so the processor's plugin list keeps a stable identity.
const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeSanitize];

/**
 * Element map. Every colour is a semantic theme token, so the same markup reads
 * correctly in either theme and nothing here hard-codes a palette.
 *
 * `node` is destructured away from each renderer because react-markdown passes
 * the mdast node alongside the DOM props, and React would warn about it landing
 * on a real element.
 */
/**
 * Reads the skill names from context so the components map can stay a module
 * constant; react-markdown would otherwise need a new map on every render.
 */
function Prose({ children }: { children: ReactNode }) {
  return <>{withSkillMentions(children, useSkillNames())}</>;
}

/**
 * A `$name` mention, bounded by whitespace so `{"$inc":` and `$sha)` are not
 * mentions. Matching the shape is not enough on its own -- see `skillMentions`.
 */
const SKILL_TOKEN = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

/**
 * Marks up `$name` where `name` is a skill that actually exists.
 *
 * The gate is the whole design. The transcript stores a mention as plain text,
 * so shape alone cannot tell one from a shell variable: across this index the
 * pattern matches ten times, and only checking each name against the skills the
 * index has seen separates the one real mention from `$IMG`, `$PKG` and
 * `$PUBLISHED`.
 */
function skillMentions(text: string, names: ReadonlySet<string>): ReactNode {
  if (names.size === 0 || !text.includes("$")) return text;

  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(SKILL_TOKEN)) {
    const lead = match[1] ?? "";
    const name = match[2] ?? "";
    if (!names.has(name)) continue;

    const start = (match.index ?? 0) + lead.length;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(
      <span
        key={`${start}:${name}`}
        // Two accents, because no single one clears contrast in both modes:
        // `primary` is a dark green that vanishes on the dark surface (border
        // 1.2:1), and `chart-1` is a light green that vanishes on white (1.2:1).
        // Measured against the rendered pixels, these give border-vs-surface
        // 4.95 light / 4.12 dark and icon-vs-chip 4.29 / 10.51.
        className="inline-flex items-center gap-1 rounded-md border border-primary bg-primary/10 px-1.5 py-0.5 align-middle font-mono text-[0.8em] leading-none text-foreground dark:border-chart-1/50 dark:bg-chart-1/15"
      >
        <BoxIcon className="size-3 shrink-0 text-primary dark:text-chart-1" aria-hidden="true" />
        {name}
      </span>,
    );
    cursor = start + name.length + 1;
  }

  if (cursor === 0) return text;
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

/**
 * Walks rendered markdown children, marking mentions in their text.
 *
 * `code` and `a` are left alone: a `$name` inside a command or a URL is part of
 * that command or URL, not a reference to a skill.
 */
function withSkillMentions(children: ReactNode, names: ReadonlySet<string>): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") return skillMentions(child, names);
    if (!isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(child)) return child;

    // A custom component replaces the intrinsic type, so the hast node it
    // carries is the only reliable way to know what element this really is.
    const tag = typeof child.type === "string" ? child.type : child.props.node?.tagName;
    if (tag === "code" || tag === "a") return child;
    if (!("children" in child.props)) return child;

    return cloneElement(child, undefined, withSkillMentions(child.props.children, names));
  });
}

/**
 * True only for schemes a browser can actually follow from here.
 *
 * Everything else -- a relative path, an absolute filesystem path, a bare
 * fragment -- is a reference rather than a destination. Anything dangerous is
 * already gone: rehype-sanitize runs before this.
 */
function isWebLink(href: string | undefined): href is string {
  return href !== undefined && /^(https?:|mailto:)/i.test(href);
}

const COMPONENTS: Components = {
  h1: ({ node, className, ...props }) => (
    <h1
      className={cn("mt-4 mb-2 text-base font-semibold text-foreground first:mt-0", className)}
      {...props}
    />
  ),
  h2: ({ node, className, ...props }) => (
    <h2
      className={cn("mt-4 mb-2 text-sm font-semibold text-foreground first:mt-0", className)}
      {...props}
    />
  ),
  h3: ({ node, className, ...props }) => (
    <h3
      className={cn("mt-3 mb-1.5 text-sm font-semibold text-foreground first:mt-0", className)}
      {...props}
    />
  ),
  h4: ({ node, className, ...props }) => (
    <h4
      className={cn(
        "mt-3 mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase first:mt-0",
        className,
      )}
      {...props}
    />
  ),

  p: ({ node, className, children, ...props }) => (
    <p className={cn("my-2 leading-[1.75] first:mt-0 last:mb-0", className)} {...props}>
      <Prose>{children}</Prose>
    </p>
  ),

  ul: ({ node, className, ...props }) => (
    <ul
      className={cn(
        "my-2 list-disc space-y-1 pl-5 marker:text-muted-foreground first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  ol: ({ node, className, ...props }) => (
    <ol
      className={cn(
        "my-2 list-decimal space-y-1 pl-5 marker:text-muted-foreground first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  li: ({ node, className, children, ...props }) => (
    // Nested lists sit tighter than the top-level one, which owns the rhythm.
    <li className={cn("leading-[1.75] [&>ul]:my-1 [&>ol]:my-1", className)} {...props}>
      <Prose>{children}</Prose>
    </li>
  ),
  // GFM task lists. The sanitizer only lets a disabled checkbox through, so
  // this can never be interactive.
  input: ({ node, className, ...props }) => (
    <input className={cn("mr-1.5 -mt-0.5 align-middle accent-primary", className)} {...props} />
  ),

  strong: ({ node, className, ...props }) => (
    <strong className={cn("font-semibold text-foreground", className)} {...props} />
  ),
  em: ({ node, className, ...props }) => <em className={cn("italic", className)} {...props} />,
  del: ({ node, className, ...props }) => (
    <del className={cn("line-through opacity-70", className)} {...props} />
  ),

  // One `code` renderer for both positions. Inline gets the chip; the `pre`
  // descendant variant strips it back off inside a block, so a fenced block is
  // not a chip inside a box. Vertical padding on an inline box does not grow
  // the line box, so the chip cannot shift the line it sits on.
  code: ({ node, className, ...props }) => (
    <code
      className={cn(
        "rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground",
        "[pre_&]:bg-transparent [pre_&]:p-0 [pre_&]:text-inherit",
        className,
      )}
      {...props}
    />
  ),
  // `max-w-full` plus `overflow-x-auto` is what keeps a 400-character line
  // inside the ~570px transcript pane instead of widening the whole column.
  pre: ({ node, className, ...props }) => (
    <pre
      className={cn(
        "my-3 max-w-full overflow-x-auto rounded-md border border-border bg-muted/50 p-3",
        "font-mono text-xs leading-relaxed text-foreground first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),

  blockquote: ({ node, className, ...props }) => (
    <blockquote
      className={cn("my-3 border-l-2 border-border pl-3 text-muted-foreground italic", className)}
      {...props}
    />
  ),
  hr: ({ node, className, ...props }) => (
    <hr className={cn("my-4 border-border", className)} {...props} />
  ),

  /**
   * A link, unless it points at a file rather than the web.
   *
   * Messages routinely reference repository files as `[README.md](path/to.md)`.
   * That is a path, not a URL, so an anchor resolves it against the dashboard's
   * own origin and offers to navigate somewhere that does not exist. Rendering
   * those as a monospace chip is the honest form: the browser cannot open a
   * local file, and the path is what the reader wanted to see anyway.
   */
  a: ({ node, className, children, href, ...props }) => {
    if (!isWebLink(href)) {
      return (
        <code
          className={cn(
            "rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground",
            className,
          )}
          title={href}
        >
          {children}
        </code>
      );
    }

    return (
      <a
        href={href}
        // Set here rather than in the schema: the sanitizer never sees these,
        // because the components map builds the element after it has run.
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "break-words text-primary underline underline-offset-2 hover:no-underline",
          className,
        )}
        {...props}
      >
        {children}
      </a>
    );
  },

  // A markdown image is model output pointing anywhere, so it is boxed to a
  // thumbnail rather than trusted with the pane's height.
  img: ({ node, className, ...props }) => (
    <img
      loading="lazy"
      className={cn(
        "my-2 max-h-64 max-w-full rounded-md border border-border object-contain",
        className,
      )}
      {...props}
    />
  ),

  // The scroll container, not the table, owns the overflow: a table cannot
  // scroll itself. `w-max min-w-full` lets the table grow past the pane when
  // its content demands it — otherwise `w-full` would crush the columns.
  table: ({ node, className, ...props }) => (
    <div className="my-3 max-w-full overflow-x-auto">
      <table className={cn("w-max min-w-full border-collapse text-xs", className)} {...props} />
    </div>
  ),
  thead: ({ node, className, ...props }) => (
    <thead className={cn("bg-muted", className)} {...props} />
  ),
  tbody: ({ node, className, ...props }) => <tbody className={className} {...props} />,
  tr: ({ node, className, ...props }) => <tr className={className} {...props} />,
  th: ({ node, className, ...props }) => (
    <th
      className={cn(
        "border border-border px-2.5 py-1.5 text-left align-top font-semibold text-foreground",
        className,
      )}
      {...props}
    />
  ),
  td: ({ node, className, ...props }) => (
    <td
      className={cn("border border-border px-2.5 py-1.5 text-left align-top", className)}
      {...props}
    />
  ),
};

interface MarkdownProps {
  /** The markdown source. */
  children: string;
  /** Extra classes for the wrapper; colour and size are inherited from it. */
  className?: string;
}

export const Markdown = memo(function Markdown({ children, className }: MarkdownProps) {
  return (
    // `break-words` only, no `whitespace-*`: the rendered tree carries its own
    // white-space rules (`pre` needs `pre`, prose needs `normal`), and forcing
    // one here would break both.
    <div className={cn("min-w-0 break-words", className)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
