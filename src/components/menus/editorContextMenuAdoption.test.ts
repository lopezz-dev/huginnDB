/**
 * Every Monaco editor in the app opens HuginnDB's right-click menu.
 *
 * Monaco's own menu is off for every editor in one place (`contextmenu: false`
 * in `editorOptionsFromPrefs`), so an editor that is not wrapped in
 * `EditorContextMenu` has no menu at all — nothing a reviewer would notice in
 * a diff. This walks `src/` for files that render `@monaco-editor/react`'s
 * `<Editor>` and fails on one that does not also use `EditorContextMenu`.
 *
 * Read as text on purpose, like `ui/uiAdoption.test.ts`: the question is
 * about the source, and rendering every editor to find out would need the
 * whole app.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..", "..");

/**
 * Editors that keep no menu, each with the reason. Not a backlog: adding one
 * here is a decision, not a deferral.
 */
const WITHOUT_MENU: Record<string, string> = {
  // The AI panel's SQL blocks: decided with Alex on 19-11 that they stay
  // without a menu (their options turn Monaco's off on their own).
  "components/ai/parts/SqlBlock.tsx": "AI panel SQL block",
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

/** Files that import Monaco's React component and render it. */
function monacoEditors(): string[] {
  return sources(SRC)
    .filter((path) => {
      const text = readFileSync(path, "utf8");
      return /from "@monaco-editor\/react"/.test(text) && /<Editor\b/.test(text);
    })
    .map((path) => relative(SRC, path).replace(/\\/g, "/"))
    .sort();
}

describe("Monaco editors and their right-click menu", () => {
  it("finds the editors at all (the scan is not silently empty)", () => {
    expect(monacoEditors()).toContain("components/query/QueryEditorTab.tsx");
  });

  it("every editor is wrapped in EditorContextMenu, or is a listed exception", () => {
    const unwrapped = monacoEditors().filter(
      (file) =>
        !(file in WITHOUT_MENU) &&
        !/<EditorContextMenu\b/.test(readFileSync(join(SRC, file), "utf8")),
    );
    expect(unwrapped).toEqual([]);
  });

  it("every listed exception still renders an editor", () => {
    expect(Object.keys(WITHOUT_MENU).filter((f) => !monacoEditors().includes(f))).toEqual([]);
  });
});
