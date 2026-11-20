/**
 * HuginnDB's context menu on a Monaco editor, in place of Monaco's own
 * (ADR #143).
 *
 * Monaco's native menu was the one menu in the app in English, without icons,
 * in the editor theme's colours rather than the app's — and its Paste went
 * through the webview clipboard, which makes WebView2 ask for permission
 * (ADR #63). The editor has to be created with `contextmenu: false`; this
 * component then wraps the element that holds it, so a right-click anywhere
 * on the editor opens `ContextActionMenu` with `editorMenu`'s description.
 *
 * Reusable on purpose: nothing here knows about query tabs. A call site hands
 * over the editor once it has mounted, the menu's header, and whichever of
 * `EditorMenuCapabilities` it can do; the clipboard entries come for free,
 * and a read-only editor (Monaco's own `readOnly` option, read when the menu
 * opens) gets Copy and Select all instead.
 */

import { useEffect, useRef, type HTMLAttributes, type MouseEvent, type ReactNode } from "react";
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

  // Runs before Radix's own handler on the trigger (Slot composes the child's
  // handler first), so the caret has moved by the time the menu reads the
  // editor's state. Monaco moves it too when its menu is off, but that is an
  // implementation detail of Monaco's, and the menu's Cut and Copy depend on
  // it; doing it here makes it ours.
  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
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
      <div {...container} ref={containerRef} onContextMenu={onContextMenu}>
        {children}
      </div>
    </ContextActionMenu>
  );
}
