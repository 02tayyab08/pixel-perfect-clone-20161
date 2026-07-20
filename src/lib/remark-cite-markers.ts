import type { Root, Text, Parents } from "mdast";
import { visit } from "unist-util-visit";
import { CITE_SENTINEL_RE } from "@/lib/citations";

/**
 * Turn plain-text ⟦N⟧ sentinels into custom mdast/hast nodes that render as
 * non-navigating cite buttons (never <a href>).
 */
export function remarkCiteMarkers() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent: Parents | undefined) => {
      if (parent == null || typeof index !== "number") return;
      if (!node.value.includes("⟦")) return;

      const re = new RegExp(CITE_SENTINEL_RE.source, "g");
      const parts: Array<Text | Record<string, unknown>> = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(node.value)) !== null) {
        if (m.index > last) {
          parts.push({ type: "text", value: node.value.slice(last, m.index) });
        }
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0) {
          parts.push({
            type: "citeMarker",
            data: {
              hName: "citeMarker",
              hProperties: { n },
            },
            children: [],
          });
        } else {
          parts.push({ type: "text", value: m[0] });
        }
        last = m.index + m[0].length;
      }
      if (parts.length === 0) return;
      if (last < node.value.length) {
        parts.push({ type: "text", value: node.value.slice(last) });
      }

      (parent.children as unknown[]).splice(index, 1, ...parts);
      return index + parts.length;
    });
  };
}
