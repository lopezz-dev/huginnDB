/**
 * Every color token below is a `light-dark(...)` value (see index.css /
 * themes.ts), not a raw "H S% L%" triple, so `hsl(var(--x))` would
 * double-wrap it into an invalid value — hence `color-mix()` to apply an
 * alpha modifier (`bg-brand/25`). But Tailwind pays that `color-mix()` +
 * `calc()` cost even when there is NO modifier (`bg-card`, `border-border`),
 * and `border-border` in particular lands on `* { @apply border-border }`
 * in index.css — i.e. every DOM node's border-color. `colorToken` skips the
 * layer in that case by returning the bare `var(--x)`.
 *
 * Tailwind invokes a function-valued color token with `{opacityValue}` from
 * three call sites (verified against the installed tailwindcss/lib):
 *   - `toColorValue` (no modifier, e.g. `bg-card`) — calls `fn({})`, so
 *     `opacityValue` is `undefined`.
 *   - `withAlphaValue` (an explicit modifier, e.g. `bg-card/40`) — calls
 *     `fn({opacityValue: "0.4"})`.
 *   - The same path also feeds gradient stops (`from-brand`) with the
 *     numeric literal `0` (`withAlphaValue(value, 0, ...)`), which is why
 *     the guard below tests `=== undefined` rather than a falsy check: `!0`
 *     is `true`, so a falsy guard would render `from-brand`'s "faded to
 *     transparent" stop as fully opaque instead.
 */
function colorToken(cssVar) {
  return ({ opacityValue }) => {
    if (opacityValue === undefined || opacityValue === 1 || opacityValue === "1") {
      return `var(${cssVar})`;
    }
    return `color-mix(in srgb, var(${cssVar}) calc(${opacityValue} * 100%), transparent)`;
  };
}

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // The legacy `bg-opacity-*`/`text-opacity-*`/... utilities (and their
  // `--tw-*-opacity` custom properties) are what would otherwise route a
  // *classless* `bg-card` through `withAlphaVariable` instead of
  // `toColorValue`, which always calls the color function with a variable
  // reference rather than `undefined` — defeating `colorToken`'s no-modifier
  // branch. Verified zero uses of any of these utilities/variables in
  // src/ and index.html.
  corePlugins: {
    backgroundOpacity: false,
    borderOpacity: false,
    divideOpacity: false,
    placeholderOpacity: false,
    ringOpacity: false,
    textOpacity: false,
  },
  theme: {
    container: {
      center: true,
      padding: "1rem",
    },
    extend: {
      colors: {
        // See `colorToken` above for the mechanism. Every token below is
        // wrapped uniformly — including ones with no `/modifier` use today —
        // rather than leaving a gap that fails silently (opaque instead of
        // translucent, no build error) the day someone writes `pk/50`.
        border: colorToken("--border"),
        input: colorToken("--input"),
        ring: colorToken("--ring"),
        // The modal scrim. Opaque token, alpha from the utility
        // (`bg-scrim/35 dark:bg-scrim/70`) — see themes.ts.
        scrim: colorToken("--scrim"),
        background: colorToken("--background"),
        foreground: colorToken("--foreground"),
        primary: {
          DEFAULT: colorToken("--primary"),
          foreground: colorToken("--primary-foreground"),
        },
        secondary: {
          DEFAULT: colorToken("--secondary"),
          foreground: colorToken("--secondary-foreground"),
        },
        destructive: {
          DEFAULT: colorToken("--destructive"),
          foreground: colorToken("--destructive-foreground"),
        },
        muted: {
          DEFAULT: colorToken("--muted"),
          foreground: colorToken("--muted-foreground"),
        },
        accent: {
          DEFAULT: colorToken("--accent"),
          foreground: colorToken("--accent-foreground"),
        },
        brand: {
          DEFAULT: colorToken("--brand"),
          foreground: colorToken("--brand-foreground"),
          // The brand surface under the pointer. Enables `hover:bg-brand-hover`
          // instead of `hover:bg-brand/90` — a transparency fades the accent
          // into the surface on dark themes, which is backwards for a hover.
          hover: colorToken("--brand-hover"),
        },
        success: {
          DEFAULT: colorToken("--success"),
          foreground: colorToken("--success-foreground"),
        },
        warning: {
          DEFAULT: colorToken("--warning"),
          foreground: colorToken("--warning-foreground"),
        },
        // Data-semantic accents (text/icon only). Enable `text-pk`, `text-fk`,
        // `text-numeric` and `decoration-fk` — see index.css for rationale.
        pk: colorToken("--pk"),
        fk: colorToken("--fk"),
        numeric: colorToken("--numeric"),
        popover: {
          DEFAULT: colorToken("--popover"),
          foreground: colorToken("--popover-foreground"),
        },
        card: {
          DEFAULT: colorToken("--card"),
          foreground: colorToken("--card-foreground"),
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        // IBM Plex Sans is self-hosted (`@fontsource-variable/ibm-plex-sans`,
        // imported in `main.tsx`), so every install renders the same face; the
        // family name of the bundled variable font is the one with the
        // `Variable` suffix. The platform UI sans after it only ever shows for
        // a script the bundled subsets do not cover. This replaces Tailwind's
        // default sans so the whole app stops rendering in the system default.
        sans: [
          "IBM Plex Sans Variable",
          "IBM Plex Sans",
          "Segoe UI Variable",
          "Segoe UI",
          "-apple-system",
          "BlinkMacSystemFont",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "Fira Code", "Consolas", "monospace"],
      },
      fontSize: {
        // Tokenised micro-type scale for this dense desktop tool. The codebase
        // was littered with arbitrary `text-[9px]/[10px]/[11px]` values with no
        // rhythm; `2xs` (11px) and `3xs` (10px) replace them and enforce a
        // legibility floor of 10px (9px chips/tags were below comfortable size).
        "3xs": ["0.625rem", { lineHeight: "0.875rem" }],
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      boxShadow: {
        // Elevation scale keyed off `--foreground` (not a fixed black) so lifts
        // read correctly in light themes (soft dark shadow) and as a faint
        // separating halo in dark themes — mirrors the `.outer-dock` island
        // treatment in index.css. Everything was previously flat (a single
        // radius, ad-hoc `shadow-lg/xl`); this gives popovers/dialogs/cards a
        // consistent depth ramp.
        "elevation-1": "0 1px 2px color-mix(in srgb, var(--foreground) 6%, transparent), 0 1px 1px color-mix(in srgb, var(--foreground) 4%, transparent)",
        "elevation-2": "0 2px 6px color-mix(in srgb, var(--foreground) 8%, transparent), 0 1px 2px color-mix(in srgb, var(--foreground) 6%, transparent)",
        "elevation-3": "0 8px 24px color-mix(in srgb, var(--foreground) 12%, transparent), 0 2px 6px color-mix(in srgb, var(--foreground) 8%, transparent)",
        "elevation-4": "0 16px 48px color-mix(in srgb, var(--foreground) 18%, transparent), 0 4px 12px color-mix(in srgb, var(--foreground) 10%, transparent)",
        // Brand affordance glow — the hover/active state of anything that
        // spends the accent blue (primary buttons, the active connection card).
        // Deliberately short-range: the brief rules out neon halos.
        brand: "0 2px 12px color-mix(in srgb, var(--brand) 35%, transparent)",
        // The workspace island's lift, promoted from the hand-written
        // string that used to live inline in `shell/IslandShell.tsx`.
        // Deliberately flatter than `elevation-3` and far lighter than
        // `elevation-4`: an island sits ON the trench, it does not float
        // over it. `workbench`-tier dialogs borrow it so a full-screen
        // dialog reads as the island lifted out, not as a foreign card.
        island:
          "0 1px 2px color-mix(in srgb, var(--foreground) 4%, transparent), 0 6px 20px color-mix(in srgb, var(--foreground) 5%, transparent)",
        "brand-ring": "0 0 0 1px color-mix(in srgb, var(--brand) 35%, transparent), 0 2px 12px color-mix(in srgb, var(--brand) 28%, transparent)",
      },
      transitionDuration: {
        // The brand motion band is 150–220ms; Tailwind ships 150/200/300, so
        // the two ends that were missing are added rather than letting call
        // sites round to 300 (which reads sluggish on a desktop tool).
        180: "180ms",
        220: "220ms",
      },
      keyframes: {
        // "Pequeños destellos azules al completar acciones" — one short brand
        // pulse on the element that just succeeded. Not a loop: it fires once
        // and leaves nothing behind.
        "brand-flash": {
          "0%": { boxShadow: "0 0 0 0 color-mix(in srgb, var(--brand) 55%, transparent)" },
          "70%": { boxShadow: "0 0 0 6px color-mix(in srgb, var(--brand) 0%, transparent)" },
          "100%": { boxShadow: "0 0 0 0 color-mix(in srgb, var(--brand) 0%, transparent)" },
        },
        // The shared open/appear motion: fade + 98→100% scale, per the brief.
        "pop-in": {
          from: { opacity: "0", transform: "scale(0.98)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "brand-flash": "brand-flash 520ms ease-out 1",
        "pop-in": "pop-in 180ms ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
