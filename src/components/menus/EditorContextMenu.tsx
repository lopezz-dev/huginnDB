/**
 * HuginnDB's context menu on a Monaco editor, in place of Monaco's own
 * (ADR #143).
 *
 * Monaco's native menu was the one menu in the app in English, without icons,
 * in the editor theme's colours rather than the app's — and its Paste went
 * through the webview clipboard, which makes WebView2 ask for permission
 * (ADR #63). Monaco's menu is turned off for every editor in one place
 * (`contextmenu: false` in `editorOptionsFromPrefs`); this component then
 * wraps the element that holds the editor, so a right-click anywhere on it
 * opens `ContextActionMenu` with `editorMenu`'s description.
 *
 * Every Monaco editor in the app goes through here, the AI panel's SQL blocks
 * excepted (they have no menu at all, on purpose).
 * `editorContextMenuAdoption.test.ts` fails on an editor that is not wrapped,
 * which would otherwise have no menu at all.
 *
 * Reusable on purpose: nothing here knows about query tabs. A call site hands
 * over the editor once it has mounted (`useMenuEditor`), the menu's header,
 * and whichever of `EditorMenuCapabilities` it can do; the clipboard entries
 * come for free, and a read-only editor (Monaco's own `readOnly` option, read
 * when the menu opens) gets Copy and Select all instead.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { ContextActionMenu } from "@/components/menus/ContextActionMenu";
import { editorMenu, type EditorMenuCapabilities } from "@/components/menus/editorMenu";
import type { ContextMenuWidth } from "@/components/ui/context-menu";
import type { MenuHeader } from "@/lib/menu/menuSpec";
import {
  caretClientPoint,
  editorCommands,
  editorMenuState,
  isContextMenuChord,
  placeCaretAt,
  type CommandEditor,
} from "@/lib/monaco/editorCommands";

export interface EditorContextMenuProps
  extends EditorMenuCapabilities,
    Omit<HTMLAttributes<HTMLDivElement>, "onContextMenu" | "children"> {
  /** The mounted editor, or `null` before `onMount` — while it is `null` a
   *  right-click opens nothing. Its identity is stable for the editor's life. */
  editor: CommandEditor | null;
  /** What the menu is about: the tab, the column, the view. */
  header: MenuHeader;
  width: ContextMenuWidth;
  /** The Monaco `<Editor>` (or the element around it). */
  children: ReactNode;
}

export function EditorContextMenu({
  editor,
  header,
  width,
  format,
  ai,
  commandPalette,
  children,
  ...container
}: EditorContextMenuProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);

  // Shift+F10 opens the menu at the caret. Radix opens on any `contextmenu`
  // event at its coordinates, so a synthetic one on the trigger is the whole
  // mechanism — no prop on `ContextActionMenu`. Keyed on the editor, whose
  // identity is stable for its life.
  useEffect(() => {
    if (!editor) return;
    const sub = editor.onKeyDown(({ browserEvent }) => {
      if (!isContextMenuChord(browserEvent)) return;
      const at = caretClientPoint(editor);
      const target = containerRef.current;
      if (!at || !target) return;
      browserEvent.preventDefault();
      browserEvent.stopPropagation();
      target.dispatchEvent(
        new window.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: at.x,
          clientY: at.y,
        }),
      );
    });
    return () => sub.dispose();
  }, [editor]);

  // `ContextActionMenu`'s aiming hook: it runs before the menu opens, so the
  // caret has moved by the time the menu reads the editor's state. Monaco
  // moves it too when its menu is off, but that is an implementation detail
  // of Monaco's, and the menu's Cut and Copy depend on it; doing it here makes
  // it ours. Shift+F10's synthetic event above goes through it as well — it
  // is dispatched on the trigger, at the caret, so the caret stays put.
  const onContextMenu = (e: MouseEvent<HTMLElement>) => {
    // Not mounted yet: nothing to act on. A default-prevented event is one
    // Radix does not open on.
    if (!editor) {
      e.preventDefault();
      return;
    }
    placeCaretAt(editor, e.clientX, e.clientY);
  };

  return (
    <ContextActionMenu
      width={width}
      onContextMenu={onContextMenu}
      menu={() =>
        // A right-click before mount never opens, so the empty branch is
        // only there for the type.
        editor
          ? editorMenu({
              t,
              header,
              state: editorMenuState(editor),
              commands: editorCommands(editor),
              format,
              ai,
              commandPalette,
            })
          : { header, entries: [] }
      }
    >
      <div {...container} ref={containerRef}>
        {children}
      </div>
    </ContextActionMenu>
  );
}

/**
 * The mounted editor, for `EditorContextMenu`: `[editor, attach]`, with
 * `attach` called from the `<Editor>`'s `onMount` (or as it). `editor` is
 * `null` until then, and changes only when Monaco mounts a new editor (a
 * remount by `key`, say) — the identity the menu's keyboard effect keys on.
 * `attach` is stable.
 */
export function useMenuEditor(): [CommandEditor | null, (editor: unknown) => void] {
  const [editor, setEditor] = useState<CommandEditor | null>(null);
  // Monaco's `IStandaloneCodeEditor` is a superset of `CommandEditor`; the
  // cast lives here so no call site imports the heavy type to make it.
  const attach = useCallback((mounted: unknown) => setEditor(mounted as CommandEditor), []);
  return [editor, attach];
}
