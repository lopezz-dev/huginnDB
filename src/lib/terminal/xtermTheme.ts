/**
 * The xterm.js colour theme for the active HuginnDB palette.
 *
 * The surface (background, text, cursor, selection) comes from the palette so
 * the terminal sits in the dock like every other panel. Of the sixteen ANSI
 * colours, the four that carry meaning take the palette's semantic tokens —
 * red is `destructive`, green `success`, yellow `warning`, blue `brand` — so
 * `mongosh`'s errors and a shell's prompt read in the app's own vocabulary.
 * The rest keep VS Code's terminal defaults for the mode, which every CLI's
 * colour choices were tuned against.
 */

import type { ITheme } from "@xterm/xterm";
import type { ThemeColors, ThemeMode } from "@/lib/themes";

const ANSI_DARK = {
  black: "#000000",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

const ANSI_LIGHT = {
  black: "#000000",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

/** `#rrggbb` plus an alpha byte; anything else is returned unchanged. */
function withAlpha(hex: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const byte = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${byte}`;
}

export function xtermTheme(colors: ThemeColors, mode: ThemeMode): ITheme {
  return {
    ...(mode === "dark" ? ANSI_DARK : ANSI_LIGHT),
    background: colors.background,
    foreground: colors.foreground,
    cursor: colors.brand,
    cursorAccent: colors.background,
    selectionBackground: withAlpha(colors.brand, 0.3),
    red: colors.destructive,
    green: colors.success,
    yellow: colors.warning,
    blue: colors.brand,
  };
}
