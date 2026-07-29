import type { SyntaxStyle } from "./types";

export interface PrismPalette {
  background: string;
  text: string;
  textSecondary: string;
  muted: string;
  accent: string;
  success: string;
  error: string;
  warning: string;
  info: string;
  cool: string;
}

function hexChannels(value: string): [number, number, number] {
  const number = Number.parseInt(value.slice(1), 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

function relativeLuminance(value: string): number {
  const channels = hexChannels(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

function mixHex(source: string, target: string, targetWeight: number): string {
  const sourceChannels = hexChannels(source);
  const targetChannels = hexChannels(target);
  return `#${sourceChannels
    .map((channel, index) =>
      Math.round(channel + (targetChannels[index] - channel) * targetWeight)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Preserve the Theme hue while moving it toward the paired code foreground. */
function readableCodeColor(
  color: string,
  background: string,
  codeText: string,
): string {
  if (contrastRatio(color, background) >= 4.5) return color;
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mixHex(color, codeText, step / 20);
    if (contrastRatio(candidate, background) >= 4.5) return candidate;
  }
  return codeText;
}

/** Build one scheme-specific Prism palette from the Theme's semantic colors. */
export function createPrismStyle(colors: PrismPalette): SyntaxStyle {
  const readable = (color: string) =>
    readableCodeColor(color, colors.background, colors.text);
  return {
    'pre[class*="language-"]': {
      color: colors.text,
      background: "var(--code-bg)",
      borderRadius: "0.5rem",
      padding: "1rem",
      margin: "0",
      fontSize: "var(--text-sm)",
      lineHeight: "1.6",
      fontFamily: "var(--font-code)",
    },
    'code[class*="language-"]': {
      color: colors.text,
      background: "transparent",
      fontSize: "var(--text-sm)",
      lineHeight: "1.6",
      fontFamily: "var(--font-code)",
    },
    comment: { color: readable(colors.muted), fontStyle: "italic" },
    punctuation: { color: readable(colors.textSecondary) },
    property: { color: readable(colors.error) },
    boolean: { color: readable(colors.warning) },
    number: { color: readable(colors.warning) },
    selector: { color: readable(colors.success) },
    string: { color: readable(colors.success) },
    operator: { color: readable(colors.cool) },
    keyword: { color: readable(colors.accent) },
    function: { color: readable(colors.info) },
    variable: { color: readable(colors.warning) },
    deleted: { color: readable(colors.error) },
    inserted: { color: readable(colors.success) },
  };
}
