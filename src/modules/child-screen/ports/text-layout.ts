import type { TextLayout } from "../contracts/navigator.js";

export type { TextLayout };

/** ASCII-width layout for module tests. Production injects Pi's ANSI-aware helpers. */
export function createAsciiTextLayout(): TextLayout {
  const widthOf = (text: string): number => [...text].length;
  return {
    visibleWidth: widthOf,
    truncate(text, width, ellipsis = "…") {
      if (widthOf(text) <= width) return text;
      if (width <= widthOf(ellipsis)) return ellipsis.slice(0, Math.max(0, width));
      const budget = width - widthOf(ellipsis);
      return `${[...text].slice(0, budget).join("")}${ellipsis}`;
    },
    wrap(text, width) {
      const wrapWidth = Math.max(1, width);
      const lines: string[] = [];
      for (const source of text.split("\n")) {
        if (!source) {
          lines.push("");
          continue;
        }
        const chars = [...source];
        for (let index = 0; index < chars.length; index += wrapWidth) {
          lines.push(chars.slice(index, index + wrapWidth).join(""));
        }
      }
      return lines;
    },
  };
}
