import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const host = process.env.TAURI_DEV_HOST;

/**
 * Documentation files surfaced by the in-app Documentation viewer
 * (`src/lib/docs.ts`). Kept here (build side) so their last-updated dates can
 * be computed at build time; the registry in `src/lib/docs.ts` imports the
 * same files' contents via `?raw` and reads the dates from `__DOC_UPDATED__`.
 */
const DOC_FILES = [
  "docs/CONNECTIONS.md",
  "docs/ENVIRONMENTS.md",
  "docs/JSON_SCHEMAS.md",
  "docs/MONGODB.md",
  "docs/SQL_SERVER.md",
  "docs/MCP.md",
  "docs/SHORTCUTS.md",
  "docs/PULSE.md",
  "docs/AI.md",
  "docs/POLICY.md",
];

/**
 * Map each doc file to its last-commit date (ISO 8601) for `__DOC_UPDATED__`.
 * Prefers git (`log -1`); falls back to the filesystem mtime when building
 * outside a git checkout (e.g. a source tarball); `undefined` if neither
 * resolves.
 */
function docDates(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const file of DOC_FILES) {
    let date: string | undefined;
    try {
      // execFileSync (no shell): `file` comes from the constant DOC_FILES, but
      // this avoids shell interpretation entirely regardless.
      const iso = execFileSync(
        "git",
        ["log", "-1", "--format=%cI", "--", file],
        { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "ignore"] },
      )
        .toString()
        .trim();
      if (iso) date = iso;
    } catch {
      // Not a git checkout — fall through to mtime.
    }
    if (!date) {
      try {
        date = fs.statSync(path.resolve(import.meta.dirname, file)).mtime.toISOString();
      } catch {
        date = undefined;
      }
    }
    out[file] = date;
  }
  return out;
}

export default defineConfig({
  plugins: [react()],
  define: {
    __DOC_UPDATED__: JSON.stringify(docDates()),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  optimizeDeps: {
    include: ["monaco-editor/esm/vs/editor/editor.api"],
  },
  worker: {
    format: "es",
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
