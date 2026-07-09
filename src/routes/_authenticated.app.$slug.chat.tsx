import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";

type ChatMsg = {
  role: "user" | "assistant";
  content: string;
  isRefusal?: boolean;
  citations?: Array<{
    source_title: string | null;
    page: number | null;
    document_id: string | null;
    snippet?: string | null;
  }>;
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
  const isMobile = useIsMobile();

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setSettingUp(false);
    setInput("");
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
    let cits: ChatMsg["citations"] = [];
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
            cits = obj.rows;
          } else if (obj.type === "meta") {
            isRefusal = !!obj.isRefusal;
            if (isRefusal) cits = [];
          } else if (obj.type === "error") {
            acc = `Error: ${obj.message}`;
          }
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = {
              role: "assistant",
              content: acc,
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

      <div className="mt-6 flex-1 space-y-4 overflow-y-auto rounded-2xl border border-border bg-card p-6">
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Try: &ldquo;What&rsquo;s our refund policy?&rdquo;
          </p>
        ) : null}
        {messages.map((m, i) => (
          <div
            key={i}
            className={m.role === "user" ? "text-right" : ""}
          >
            <div
              className={`inline-block max-w-[85%] rounded-lg px-4 py-2 text-sm ${
                m.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted"
              }`}
            >
              {m.content || (busy && i === messages.length - 1 ? "…" : "")}
            </div>
            {!m.isRefusal && m.citations && m.citations.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {m.citations.map((c, j) => (
                  <button
                    key={j}
                    type="button"
                    onClick={() => setPanel({ msgIdx: i, citIdx: j })}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                    title={c.source_title ?? "source"}
                  >
                    <span className="font-medium text-foreground">[{j + 1}]</span>
                    <span className="max-w-[16rem] truncate">
                      {c.source_title ?? "source"}
                    </span>
                    {c.page ? <span>· p.{c.page}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {settingUp ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Setting up your workspace…
          </div>
        ) : null}
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
        answerText={panel ? messages[panel.msgIdx]?.content ?? "" : ""}
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
  answerText,
  index,
  onNavigate,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  side: "right" | "bottom";
  citations: NonNullable<ChatMsg["citations"]>;
  answerText: string;
  index: number;
  onNavigate: (next: number) => void;
}) {
  const cit = citations[index];
  const total = citations.length;
  const highlighted = cit?.snippet
    ? highlightSnippet(cit.snippet, answerText)
    : null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        className={side === "right" ? "w-full sm:max-w-lg" : "max-h-[80vh]"}
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
              [{index + 1}] of {total}
            </span>
            <span className="truncate">{cit?.source_title ?? "Source"}</span>
          </SheetTitle>
          <SheetDescription>
            {cit?.page ? `Page ${cit.page}` : "Cited excerpt from your documents"}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 px-4">
          {cit?.snippet && highlighted ? (
            <blockquote
              dir="auto"
              className="border-l-4 border-primary/50 bg-muted/60 px-4 py-3 text-sm italic leading-relaxed text-foreground"
            >
              {highlighted.map((seg, i) =>
                seg.mark ? (
                  <mark
                    key={i}
                    className="rounded bg-primary/15 px-0.5 not-italic text-foreground"
                  >
                    {seg.text}
                  </mark>
                ) : (
                  <span key={i}>{seg.text}</span>
                ),
              )}
            </blockquote>
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

// --- Snippet highlighting (heuristic; lexical sentence overlap only) ---

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","of","for","to","in","on","at",
  "by","with","as","is","are","was","were","be","been","being","it","its",
  "this","that","these","those","from","not","no","do","does","did","have",
  "has","had","you","your","we","our","they","their","he","she","him","her",
  "what","which","who","whom","how","when","where","why","can","could","would",
  "should","will","may","might","about","into","than","also","such","any",
  "all","some","one","two","more","most","other","only","just","so","up","out",
  // Arabic function words
  "في","من","إلى","على","عن","و","او","أو","ما","ماذا","هل","كيف","اين","أين",
  "متى","لماذا","هذا","هذه","ذلك","تلك","التي","الذي","الذين","هو","هي","نحن",
  "هم","انت","أنت","انا","أنا","كان","كانت","يكون","تكون","لا","لم","لن","قد",
]);

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
};

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  const raw = s.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  for (const t of raw) {
    if (!t) continue;
    const norm = NUMBER_WORDS[t] ?? t;
    if (norm.length < 3 && !/^\d+$/.test(norm)) continue;
    if (STOPWORDS.has(norm)) continue;
    out.add(norm);
  }
  return out;
}

function highlightSnippet(
  snippet: string,
  answer: string,
): Array<{ text: string; mark: boolean }> {
  const answerTokens = tokenize(answer);
  if (answerTokens.size === 0) return [{ text: snippet, mark: false }];

  // Split snippet into sentences on latin + arabic terminators, keeping delimiters.
  const parts = snippet.split(/([.!?؟\n]+\s*)/);
  const sentences: Array<{ text: string; start: number; end: number }> = [];
  let cursor = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i] ?? "";
    const trailer = parts[i + 1] ?? "";
    const full = body + trailer;
    if (full.length === 0) continue;
    sentences.push({ text: full, start: cursor, end: cursor + full.length });
    cursor += full.length;
  }

  const scores = sentences.map((s) => {
    const toks = tokenize(s.text);
    let n = 0;
    for (const t of toks) if (answerTokens.has(t)) n += 1;
    return n;
  });
  const max = Math.max(0, ...scores);
  if (max < 2) return [{ text: snippet, mark: false }];
  const threshold = Math.max(2, Math.ceil(max * 0.6));

  const segs: Array<{ text: string; mark: boolean }> = [];
  sentences.forEach((s, i) => {
    segs.push({ text: s.text, mark: scores[i] >= threshold });
  });
  // Merge adjacent segs with same mark.
  const merged: Array<{ text: string; mark: boolean }> = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.mark === s.mark) last.text += s.text;
    else merged.push({ ...s });
  }
  return merged;
}