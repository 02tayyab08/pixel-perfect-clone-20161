import { createFileRoute } from "@tanstack/react-router";

/**
 * Paste-on-your-site loader. Tenants embed:
 *   <script src="https://<host>/embed-loader.js?slug=<their-slug>" async></script>
 *
 * The script injects a floating launcher button + iframe pointing at
 * /embed/<slug> on this origin. No secrets in the script; the widget itself
 * enforces the allowed_domains check server-side.
 */
export const Route = createFileRoute("/embed-loader.js")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = new URL(request.url).origin;
        const js = `(function(){
  try {
    var currentScript = document.currentScript;
    var src = currentScript && currentScript.src ? currentScript.src : "";
    var slug = "";
    try { slug = new URL(src, location.href).searchParams.get("slug") || ""; } catch(_) {}
    if (!slug) { console.warn("[salni] missing ?slug= on embed-loader.js"); return; }
    if (document.getElementById("salni-embed-root")) return;

    var origin = ${JSON.stringify(origin)};
    var root = document.createElement("div");
    root.id = "salni-embed-root";
    root.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:2147483647;font-family:Inter,system-ui,sans-serif;";

    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", "Open assistant");
    btn.style.cssText = "width:56px;height:56px;border-radius:9999px;border:none;background:#111827;color:#fff;font-size:24px;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,0.2);";
    btn.textContent = "💬";

    var frame = document.createElement("iframe");
    frame.src = origin + "/embed/" + encodeURIComponent(slug);
    frame.title = "Assistant";
    frame.style.cssText = "display:none;position:fixed;bottom:88px;right:20px;width:380px;height:560px;max-width:calc(100vw - 40px);max-height:calc(100vh - 120px);border:none;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,0.25);background:#fff;";
    frame.allow = "clipboard-write";

    var open = false;
    btn.addEventListener("click", function(){
      open = !open;
      frame.style.display = open ? "block" : "none";
      btn.textContent = open ? "×" : "💬";
    });

    root.appendChild(frame);
    root.appendChild(btn);
    (document.body || document.documentElement).appendChild(root);
  } catch (e) {
    console.error("[salni] embed loader error", e);
  }
})();
`;
        return new Response(js, {
          status: 200,
          headers: {
            "content-type": "application/javascript; charset=utf-8",
            "cache-control": "public, max-age=300",
            "access-control-allow-origin": "*",
          },
        });
      },
    },
  },
});