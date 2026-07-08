import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Quote } from "lucide-react";

type ChatMsg = {
  role: "user" | "assistant";
  content: string;
  citations?: Array<{ source_title: string | null; page: number | null; document_id: string | null }>;
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
          } else if (obj.type === "error") {
            acc = `Error: ${obj.message}`;
          }
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = { role: "assistant", content: acc, citations: cits };
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
            {m.citations && m.citations.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {m.citations.map((c, j) => (
                  <span
                    key={j}
                    className="inline-flex items-center gap-1 rounded-md bg-background px-2 py-1 text-xs text-muted-foreground"
                  >
                    <Quote className="h-3 w-3" />
                    {c.source_title ?? "source"}
                    {c.page ? ` · p.${c.page}` : ""}
                  </span>
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
          placeholder="Ask a question…"
          disabled={busy}
        />
        <Button type="submit" disabled={busy || !input.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send"}
        </Button>
      </form>
    </div>
  );
}