import type { LinePart, RenderedLine } from "../../../modules/child-screen/public.js";

export interface PaintTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export function paintParts(parts: readonly LinePart[], theme: PaintTheme): string {
  return parts.map((part) => {
    let text = part.text;
    if (part.color) text = theme.fg(part.color, text);
    if (part.bold) text = theme.bold(text);
    return text;
  }).join("");
}

export function paintLines(lines: readonly RenderedLine[], theme: PaintTheme): string[] {
  return lines.map((line) => paintParts(line.parts, theme));
}
