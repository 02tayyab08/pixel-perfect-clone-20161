import { createFileRoute, notFound } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { getEmbedOrgBySlugFn } from "@/lib/widget.functions";

type Msg = {
  role: "user" | "assistant";
  content: string;
  isRefusal?: boolean;
  citations?: Array<{ source_title: string | null; page: number | null; snippet?: string | null }>;
};

type LoaderData = {
  org: {
    id: string;
    name: string;
    slug: string;
    branding: { [k: string]: string | number | boolean | null } | null;
    defaultLocale: string;
  };
  inactive?: { name: string };
};

export const Route = createFileRoute("/embed/$slug")({
  ssr: true,
  head: ({ loaderData }) => ({
    meta: [
      { title: `${loaderData?.org?.name ?? "Assistant"} — Chat` },
      { name: "robots", content: "noindex" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
    ],
  }),
  loader: async ({ params }): Promise<LoaderData> => {
    const res = await getEmbedOrgBySlugFn({ data: { slug: params.slug } });
    if (!res.ok) {
      if (res.reason === "inactive") {
        return {
          org: {
            id: "",
            name: res.name ?? "Assistant",
            slug: params.slug,
            branding: null,
            defaultLocale: "en",
          },
          inactive: { name: res.name ?? "Assistant" },
        };
      }
      throw notFound();
    }
    return { org: res.org };
  },
  component: EmbedPage,
});

function EmbedPage() {
  const { org, inactive } = Route.useLoaderData();
  const primary =
    (org.branding && typeof org.branding["primary_color"] === "string"
      ? (org.branding["primary_color"] as string)
      : null) ?? "#111827";
  const logo =
    org.branding && typeof org.branding["logo_url"] === "string"
      ? (org.branding["logo_url"] as string)
      : null;

  const [locale, setLocale] = useState<"en" | "ar">(
    (org.defaultLocale === "ar" ? "ar" : "en") as "en" | "ar",
  );
  const [endUserRef, setEndUserRef] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Boot: end_user_ref + saved locale, rehydrate last conversation.
  useEffect(() => {
    if (inactive || !org.id) return;
    const lsKey = `salni.eur.${org.id}`;
    let ref = localStorage.getItem(lsKey);
    if (!ref) {
      ref = crypto.randomUUID();
      localStorage.setItem(lsKey, ref);
    }
    setEndUserRef(ref);
    const savedLocale = localStorage.getItem(`salni.locale.${org.id}`);
    if (savedLocale === "en" || savedLocale === "ar") setLocale(savedLocale);

    fetch(`/api/public/widget-history?orgId=${org.id}&endUserRef=${ref}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        if (data.conversationId) setConversationId(data.conversationId);
        if (Array.isArray(data.messages) && data.messages.length > 0) {
          setMessages(
            data.messages
              .filter((m: { role: string }) => m.role === "user" || m.role === "assistant")
              .map((m: { role: "user" | "assistant"; content: string }) => ({
                role: m.role,
                content: m.content,
              })),
          );
        }
      })
      .catch(() => undefined);
  }, [org.id, inactive]);

  useEffect(() => {
    if (org.id) localStorage.setItem(`salni.locale.${org.id}`, locale);
  }, [locale, org.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const t = useMemo(
    () =>
      locale === "ar"
        ? {
            placeholder: "اسأل سؤالاً…",
            send: "إرسال",
            unavailable: "هذا المساعد غير متاح حالياً.",
            hint: "الإجابات تعتمد فقط على مستندات الشركة.",
          }
        : {
            placeholder: "Ask a question…",
            send: "Send",
            unavailable: "This assistant is currently unavailable.",
            hint: "Answers come only from the business's own documents.",
          },
    [locale],
  );

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy || !endUserRef) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);

    let res: Response;
    try {
      res = await fetch("/api/public/widget-query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId: org.id,
          conversationId: conversationId ?? null,
          endUserRef,
          locale,
          message: text,
        }),
      });
    } catch (err) {
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { role: "assistant", content: String(err) };
        return copy;
      });
      setBusy(false);
      return;
    }

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = {
          role: "assistant",
          content: body || `Error ${res.status}`,
        };
        return copy;
      });
      setBusy(false);
      return;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let acc = "";
    let cits: Msg["citations"] = [];
    let isRefusal = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const evt of events) {
        const line = evt.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          const obj = JSON.parse(line.slice(6));
          if (obj.type === "conversation") setConversationId(obj.id);
          else if (obj.type === "delta") acc += obj.text;
          else if (obj.type === "override") acc = obj.text;
          else if (obj.type === "citations") cits = obj.rows;
          else if (obj.type === "meta") {
            isRefusal = !!obj.isRefusal;
            if (isRefusal) cits = [];
          } else if (obj.type === "error") acc = `⚠ ${obj.message}`;
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
          /* ignore malformed frame */
        }
      }
    }
    setBusy(false);
  }

  if (inactive) {
    return (
      <div
        dir={locale === "ar" ? "rtl" : "ltr"}
        className="flex min-h-screen items-center justify-center bg-white p-6 text-slate-800"
      >
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold">{inactive.name}</h1>
          <p className="mt-2 text-sm text-slate-500">{t.unavailable}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      dir={locale === "ar" ? "rtl" : "ltr"}
      className="flex h-screen flex-col bg-white text-slate-900"
      style={{ fontFamily: locale === "ar" ? "'IBM Plex Arabic', sans-serif" : "Inter, sans-serif" }}
    >
      <header
        className="flex items-center justify-between border-b border-slate-200 px-4 py-3"
        style={{ borderColor: `${primary}22` }}
      >
        <div className="flex items-center gap-2">
          {logo ? (
            <img src={logo} alt="" className="h-6 w-6 rounded" />
          ) : (
            <span
              className="grid h-6 w-6 place-items-center rounded text-xs font-semibold text-white"
              style={{ background: primary }}
            >
              {org.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="text-sm font-semibold">{org.name}</span>
        </div>
        <button
          type="button"
          onClick={() => setLocale(locale === "en" ? "ar" : "en")}
          className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
        >
          {locale === "en" ? "العربية" : "English"}
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <p className="text-center text-xs text-slate-400">{t.hint}</p>
        ) : null}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <div
              className="inline-block max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm"
              style={
                m.role === "user"
                  ? { background: primary, color: "white" }
                  : { background: "#f1f5f9", color: "#0f172a" }
              }
            >
              {m.content || (busy && i === messages.length - 1 ? "…" : "")}
            </div>
            {!m.isRefusal && m.citations && m.citations.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {m.citations.map((c, j) => (
                  <span
                    key={j}
                    className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-500"
                    title={c.snippet ?? ""}
                  >
                    <span className="font-semibold text-slate-700">[{j + 1}]</span>
                    <span className="max-w-[10rem] truncate">{c.source_title ?? "source"}</span>
                    {c.page ? <span>· p.{c.page}</span> : null}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <form
        onSubmit={send}
        className="flex gap-2 border-t border-slate-200 px-4 py-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy || !endUserRef}
          placeholder={t.placeholder}
          className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400"
        />
        <button
          type="submit"
          disabled={busy || !input.trim() || !endUserRef}
          className="rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          style={{ background: primary }}
        >
          {t.send}
        </button>
      </form>
    </div>
  );
}