import { createFileRoute, notFound } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { getEmbedOrgBySlugFn } from "@/lib/widget.functions";
import { AssistantMarkdown } from "@/components/assistant-markdown";
import { useChatAutoscroll } from "@/hooks/use-chat-autoscroll";
import {
  buildCitationPresentation,
  type CitationSource,
  type GroundingChunkRow,
  type GroundingSupportRow,
} from "@/lib/citations";

type Msg = {
  role: "user" | "assistant";
  content: string;
  markedContent?: string;
  isRefusal?: boolean;
  citations?: CitationSource[];
};

type OrgBranding = {
  assistant_name: string | null;
  brand_color: string | null;
  logo_url: string | null;
} | null;

type LoaderData = {
  org: {
    id: string;
    name: string;
    slug: string;
    branding: OrgBranding;
    defaultLocale: string;
  };
  inactive?: { name: string };
  loadError?: string;
};

export const Route = createFileRoute("/embed/$slug")({
  ssr: true,
  head: (ctx) => {
    const data = (ctx as { loaderData?: LoaderData }).loaderData;
    const name = data?.org?.branding?.assistant_name ?? data?.org?.name ?? "Assistant";
    return {
      meta: [
        { title: `${name} — Chat` },
        { name: "robots", content: "noindex" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
      ],
    };
  },
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
      if (res.reason === "error") {
        console.error(`[embed] loader slug=${params.slug} loadError=${res.message}`);
        return {
          org: {
            id: "",
            name: "Assistant",
            slug: params.slug,
            branding: null,
            defaultLocale: "en",
          },
          loadError: res.message,
        };
      }
      throw notFound();
    }
    return { org: res.org };
  },
  component: EmbedPage,
});

function EmbedPage() {
  const { org, inactive, loadError } = Route.useLoaderData() as LoaderData;
  const primary = org.branding?.brand_color?.trim() || "#111827";
  const logo = org.branding?.logo_url?.trim() || null;
  const displayName = org.branding?.assistant_name?.trim() || org.name;

  const [locale, setLocale] = useState<"en" | "ar">(
    (org.defaultLocale === "ar" ? "ar" : "en") as "en" | "ar",
  );
  const [endUserRef, setEndUserRef] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeCite, setActiveCite] = useState<{ msgIdx: number; n: number } | null>(
    null,
  );
  const lastContent = messages[messages.length - 1]?.content ?? "";
  const { containerRef, bottomRef, lastUserRef, markUserSent, onScroll } =
    useChatAutoscroll(lastContent, busy);

  // Boot: end_user_ref + saved locale, rehydrate last conversation.
  useEffect(() => {
    if (inactive || loadError || !org.id) return;
    const lsKey = `salni.eur.${org.id}`;
    let ref = localStorage.getItem(lsKey);
    console.log(`[embed] localStorage ${lsKey}=${ref ?? "(null)"}`);
    if (!ref) {
      ref = crypto.randomUUID();
      localStorage.setItem(lsKey, ref);
      console.log(`[embed] generated endUserRef=${ref}`);
    }
    setEndUserRef(ref);
    const savedLocale = localStorage.getItem(`salni.locale.${org.id}`);
    if (savedLocale === "en" || savedLocale === "ar") setLocale(savedLocale);

    fetch("/api/public/widget-history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: org.slug, endUserRef: ref }),
    })
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
  }, [org.id, org.slug, inactive, loadError]);

  useEffect(() => {
    if (org.id) localStorage.setItem(`salni.locale.${org.id}`, locale);
  }, [locale, org.id]);

  const t = useMemo(
    () =>
      locale === "ar"
        ? {
            placeholder: "اسأل سؤالاً…",
            send: "إرسال",
            unavailable: "هذا المساعد غير متاح حالياً.",
            loadError: "تعذر تحميل المساعد. حاول مرة أخرى لاحقاً.",
            hint: "الإجابات تعتمد فقط على مستندات الشركة.",
          }
        : {
            placeholder: "Ask a question…",
            send: "Send",
            unavailable: "This assistant is currently unavailable.",
            loadError: "This assistant could not be loaded. Please try again later.",
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
    markUserSent();
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);

    let res: Response;
    try {
      res = await fetch("/api/public/widget-query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: org.slug,
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
    let cits: CitationSource[] = [];
    let markedContent: string | undefined;
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
          else if (obj.type === "citations") {
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
          } else if (obj.type === "error") acc = `⚠ ${obj.message}`;
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = {
              role: "assistant",
              content: acc,
              markedContent: isRefusal ? undefined : markedContent,
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

  if (loadError) {
    return (
      <div
        dir={locale === "ar" ? "rtl" : "ltr"}
        className="flex min-h-screen items-center justify-center bg-white p-6 text-slate-800"
      >
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold">{displayName}</h1>
          <p className="mt-2 text-sm text-slate-500">{t.loadError}</p>
        </div>
      </div>
    );
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
              {displayName.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="text-sm font-semibold">{displayName}</span>
        </div>
        <button
          type="button"
          onClick={() => setLocale(locale === "en" ? "ar" : "en")}
          className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
        >
          {locale === "en" ? "العربية" : "English"}
        </button>
      </header>

      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 ? (
          <p className="text-center text-xs text-slate-400">{t.hint}</p>
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
                className={`inline-block max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                  m.role === "user" ? "whitespace-pre-wrap" : "text-left"
                }`}
                style={
                  m.role === "user"
                    ? { background: primary, color: "white" }
                    : { background: "#f1f5f9", color: "#0f172a" }
                }
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
                <div className="mt-1 flex flex-wrap gap-1">
                  {m.citations.map((c) => (
                    <button
                      key={c.n}
                      type="button"
                      data-cite-chip={`${i}-${c.n}`}
                      onClick={() => setActiveCite({ msgIdx: i, n: c.n })}
                      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                        activeCite?.msgIdx === i && activeCite.n === c.n
                          ? "border-slate-400 bg-slate-100 text-slate-800"
                          : "border-slate-200 bg-white text-slate-500"
                      }`}
                    >
                      <span className="font-semibold text-slate-700">[{c.n}]</span>
                      <span className="max-w-[10rem] truncate">
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
        <div ref={bottomRef} aria-hidden className="h-px w-full" />
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
