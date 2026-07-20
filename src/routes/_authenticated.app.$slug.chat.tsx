import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AssistantMarkdown } from "@/components/assistant-markdown";
import { Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { useChatAutoscroll } from "@/hooks/use-chat-autoscroll";
import { CitationChunkBody } from "@/components/citation-chunk-body";
import {
  buildCitationPresentation,
  type CitationSource,
  type GroundingChunkRow,
  type GroundingSupportRow,
} from "@/lib/citations";
import { resolveCitationAutoPageIndex } from "@/lib/citations/autoPage";
import { computeHighlights } from "@/lib/citations/computeHighlights";
import { HIGHLIGHT_DEFAULTS } from "@/lib/citations/defaults";

type ChatMsg = {
  role: "user" | "assistant";
  content: string;
  /** Markdown with ⟦N⟧ cite sentinels — applied only after stream ends */
  markedContent?: string;
  isRefusal?: boolean;
  citations?: CitationSource[];
};

export const Route = createFileRoute("/_authenticated/app/$slug/chat")({
  head: () => ({ meta: [{ title: "Chat — Salni" }] }),
  component: ChatPage,
});

function ChatPage() {
  const { org } = Route.useRouteContext() as { org: { id: string } };
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ msgIdx: number; citIdx: number } | null>(null);
  const [activeCite, setActiveCite] = useState<{ msgIdx: number; n: number } | null>(
    null,
  );
  const isMobile = useIsMobile();
  const lastContent = messages[messages.length - 1]?.content ?? "";
  const { containerRef, bottomRef, lastUserRef, markUserSent, onScroll } =
    useChatAutoscroll(lastContent, busy);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setSettingUp(false);
    setInput("");
    markUserSent();
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);

    const doRequest = () =>
      fetch("/api/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId: org.id,
          message: text,
          ...(conversationId ? { conversationId } : {}),
        }),
      });

    let res = await doRequest();
    // Silent one-shot retry on 401: the server refreshes the Supabase session
    // cookie in-place on the next call, so retrying transparently recovers
    // from access-token expiry mid-session.
    if (res.status === 401) {
      await new Promise((r) => setTimeout(r, 150));
      res = await doRequest();
      if (res.status === 401) {
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = {
            role: "assistant",
            content: "Your session expired. Redirecting you to sign in…",
          };
          return copy;
        });
        setBusy(false);
        setTimeout(() => {
          window.location.href = "/auth/sign-in";
        }, 1200);
        return;
      }
    }
    // 409 setup-in-progress: poll gracefully.
    const started = Date.now();
    while (res.status === 409 && Date.now() - started < 30_000) {
      setSettingUp(true);
      const body = await res.clone().json().catch(() => ({ retry_after_ms: 2000 }));
      await new Promise((r) => setTimeout(r, (body?.retry_after_ms ?? 2000) + Math.floor(Math.random() * 500)));
      res = await doRequest();
    }
    setSettingUp(false);

    if (!res.ok || !res.body) {
      const bodyText = await res.text().catch(() => "");
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = {
          role: "assistant",
          content: `Error ${res.status}: ${bodyText || res.statusText || "no body"}`,
        };
        return copy;
      });
      setBusy(false);
      return;
    }

    // Parse SSE stream.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let acc = "";
    let cits: CitationSource[] = [];
    let markedContent: string | undefined;
    let isRefusal = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const evt of events) {
        const line = evt.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          const obj = JSON.parse(line.slice(6));
          if (obj.type === "conversation") setConversationId(obj.id);
          else if (obj.type === "delta") {
            acc += obj.text;
          } else if (obj.type === "override") {
            acc = obj.text;
          } else if (obj.type === "citations") {
            const chunks = (obj.chunks ?? []) as GroundingChunkRow[];
            const supports = (obj.supports ?? []) as GroundingSupportRow[];
            const plan = buildCitationPresentation(acc, chunks, supports);
            cits = plan.sources;
            markedContent = plan.markedMarkdown;
          } else if (obj.type === "meta") {
            isRefusal = !!obj.isRefusal;
            if (isRefusal) {
              cits = [];
              markedContent = undefined;
            }
          } else if (obj.type === "error") {
            acc = `Error: ${obj.message}`;
          }
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = {
              role: "assistant",
              content: acc,
              // Keep markers off while streaming — apply on the final state
              // after busy clears (see render). Store plan on the message now.
              markedContent: isRefusal ? undefined : markedContent,
              citations: isRefusal ? [] : cits,
              isRefusal,
            };
            return copy;
          });
        } catch {
          // Ignore malformed frames.
        }
      }
    }
    setBusy(false);
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-3xl flex-col">
      <h1 className="font-display text-3xl font-semibold">Chat playground</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Ask a question. Answers come only from your uploaded documents.
      </p>

      <div
        ref={containerRef}
        onScroll={onScroll}
        className="mt-6 flex-1 space-y-4 overflow-y-auto rounded-2xl border border-border bg-card p-6"
      >
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Try: &ldquo;What&rsquo;s our refund policy?&rdquo;
          </p>
        ) : null}
        {messages.map((m, i) => {
          const isLastUser =
            m.role === "user" &&
            (i === messages.length - 1 ||
              (i === messages.length - 2 && messages[i + 1]?.role === "assistant"));
          const streamingThis = busy && i === messages.length - 1;
          const showMarked =
            m.role === "assistant" &&
            !m.isRefusal &&
            !streamingThis &&
            !!m.markedContent;
          return (
            <div
              key={i}
              ref={isLastUser ? lastUserRef : undefined}
              className={m.role === "user" ? "text-right" : ""}
            >
              <div
                className={`inline-block max-w-[85%] rounded-lg px-4 py-2 text-sm ${
                  m.role === "user"
                    ? "bg-primary text-primary-foreground whitespace-pre-wrap"
                    : "bg-muted text-left"
                }`}
              >
                {m.role === "assistant" ? (
                  m.content ? (
                    <AssistantMarkdown
                      content={showMarked ? m.markedContent! : m.content}
                      activeCite={
                        activeCite?.msgIdx === i ? activeCite.n : null
                      }
                      onCiteClick={(n) => {
                        setActiveCite({ msgIdx: i, n });
                        const citIdx = (m.citations ?? []).findIndex((c) => c.n === n);
                        if (citIdx >= 0) {
                          const autoIdx = resolveCitationAutoPageIndex(
                            m.citations ?? [],
                            citIdx,
                            HIGHLIGHT_DEFAULTS.citationAutoPage,
                            computeHighlights,
                          );
                          setPanel({ msgIdx: i, citIdx: autoIdx });
                        }
                        requestAnimationFrame(() => {
                          document
                            .querySelector(`[data-cite-chip="${i}-${n}"]`)
                            ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
                        });
                      }}
                    />
                  ) : busy && i === messages.length - 1 ? (
                    "…"
                  ) : null
                ) : (
                  m.content
                )}
              </div>
              {!m.isRefusal && m.citations && m.citations.length > 0 && !streamingThis ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {m.citations.map((c) => (
                    <button
                      key={c.n}
                      type="button"
                      data-cite-chip={`${i}-${c.n}`}
                      onClick={() => {
                        setActiveCite({ msgIdx: i, n: c.n });
                        const citIdx = m.citations!.findIndex((x) => x.n === c.n);
                        const autoIdx = resolveCitationAutoPageIndex(
                          m.citations!,
                          citIdx,
                          HIGHLIGHT_DEFAULTS.citationAutoPage,
                          computeHighlights,
                        );
                        setPanel({ msgIdx: i, citIdx: autoIdx });
                      }}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${
                        activeCite?.msgIdx === i && activeCite.n === c.n
                          ? "border-primary bg-primary/5 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:border-primary hover:text-foreground"
                      }`}
                    >
                      <span className="font-medium text-foreground">[{c.n}]</span>
                      <span className="max-w-[16rem] truncate">
                        {c.source_title ?? "source"}
                      </span>
                      {c.page ? <span>· p.{c.page}</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {settingUp ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Setting up your workspace…
          </div>
        ) : null}
        <div ref={bottomRef} aria-hidden className="h-px w-full" />
      </div>

      <form onSubmit={send} className="mt-4 flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a full question, e.g. 'What is the license cost at Meydan?'"
          disabled={busy}
        />
        <Button type="submit" disabled={busy || !input.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send"}
        </Button>
      </form>

      <CitationPanel
        open={panel !== null}
        onOpenChange={(o) => !o && setPanel(null)}
        side={isMobile ? "bottom" : "right"}
        citations={panel ? messages[panel.msgIdx]?.citations ?? [] : []}
        index={panel?.citIdx ?? 0}
        onNavigate={(next) =>
          setPanel((p) => (p ? { ...p, citIdx: next } : p))
        }
      />
    </div>
  );
}

function CitationPanel({
  open,
  onOpenChange,
  side,
  citations,
  index,
  onNavigate,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  side: "right" | "bottom";
  citations: NonNullable<ChatMsg["citations"]>;
  index: number;
  onNavigate: (next: number) => void;
}) {
  const cit = citations[index];
  const total = citations.length;
  const spans =
    cit?.snippet && cit.answerSegment
      ? computeHighlights(cit.answerSegment, cit.snippet)
      : [];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        className={side === "right" ? "w-full sm:max-w-lg" : "max-h-[80vh]"}
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
              [{cit?.n ?? index + 1}] of {total}
            </span>
            <span className="truncate">{cit?.source_title ?? "Source"}</span>
          </SheetTitle>
          <SheetDescription>
            {cit?.page ? `Page ${cit.page}` : "Cited excerpt from your documents"}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 px-4">
          {cit?.snippet ? (
            <CitationChunkBody chunkText={cit.snippet} spans={spans} />
          ) : (
            <p className="text-sm text-muted-foreground">
              No snippet available for this citation.
            </p>
          )}
        </div>

        {total > 1 ? (
          <div className="mt-6 flex items-center justify-between gap-2 px-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onNavigate((index - 1 + total) % total)}
            >
              <ChevronLeft className="mr-1 h-4 w-4" /> Prev
            </Button>
            <span className="text-xs text-muted-foreground">
              {index + 1} / {total}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onNavigate((index + 1) % total)}
            >
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
