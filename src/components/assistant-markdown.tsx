import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { remarkCiteMarkers } from "@/lib/remark-cite-markers";

/**
 * Renders assistant message markdown safely (no raw HTML) with GFM tables.
 * Citation markers are ⟦N⟧ sentinels turned into buttons — never <a href>.
 */
export function AssistantMarkdown({
  content,
  className,
  onCiteClick,
  activeCite,
}: {
  content: string;
  className?: string;
  onCiteClick?: (n: number) => void;
  activeCite?: number | null;
}) {
  if (!content) return null;

  return (
    <div
      className={cn(
        "assistant-md text-sm leading-relaxed break-words",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCiteMarkers]}
        // Default: no raw HTML. Do not add rehype-raw.
        components={{
          // Custom hast element from remarkCiteMarkers — must not be an <a>.
          ...({
            citeMarker: ({ n }: { n?: number | string }) => {
              const num = typeof n === "string" ? Number(n) : n;
              if (!num || !Number.isFinite(num)) return null;
              const active = activeCite === num;
              return (
                <button
                  type="button"
                  data-cite={num}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onCiteClick?.(num);
                  }}
                  className={cn(
                    "mx-0.5 inline-flex translate-y-[-1px] cursor-pointer items-center rounded px-1 py-0 text-[0.7rem] font-semibold leading-none",
                    "bg-black/10 text-current/90 underline-offset-2 hover:bg-black/15 hover:underline dark:bg-white/15",
                    active && "ring-2 ring-current/40",
                  )}
                >
                  [{num}]
                </button>
              );
            },
          } as Record<string, unknown>),
          h1: ({ children }) => (
            <h1 className="mt-3 mb-1.5 text-base font-semibold tracking-tight">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-3 mb-1.5 text-sm font-semibold tracking-tight">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-2.5 mb-1 text-sm font-semibold">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mt-2 mb-1 text-sm font-medium">{children}</h4>
          ),
          p: ({ children }) => <p className="my-1.5">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          ul: ({ children }) => (
            <ul className="my-1.5 list-disc space-y-0.5 ps-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1.5 list-decimal space-y-0.5 ps-5">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 opacity-90 hover:opacity-100"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-1.5 border-s-2 border-current/25 ps-3 opacity-90">
              {children}
            </blockquote>
          ),
          code: ({ className: codeClass, children, ...props }) => {
            const isBlock = Boolean(codeClass);
            if (isBlock) {
              return (
                <code className={cn("font-mono text-xs", codeClass)} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className="rounded bg-black/5 px-1 py-0.5 font-mono text-[0.85em] dark:bg-white/10"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-md bg-black/5 p-2 text-xs dark:bg-white/10">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-2 w-full overflow-x-auto">
              <table className="w-full border-collapse text-start text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="border-b border-current/15">{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="border-b border-current/10 last:border-0">{children}</tr>,
          th: ({ children }) => (
            <th className="px-2 py-1.5 text-start font-semibold align-top">{children}</th>
          ),
          td: ({ children }) => (
            <td className="px-2 py-1.5 align-top">{children}</td>
          ),
          hr: () => <hr className="my-3 border-current/15" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
