/**
 * Docked right-side cell editor (JetBrains-style). Renders the shared
 * `CellEditorBody` against whatever cell the user last sent here via the
 * `useCellEditor` store — from the grid's "Open in side editor" context-menu
 * item, or the "move to side panel" button in the modal editor.
 *
 * Lives inside `IslandShell` as a manual split (see that file), sized via
 * `panelLayout.sideEditorWidth`/`sideEditorOpen`.
 *
 * One session PER TAB, not one global slot. Switching tabs used to force-close
 * this panel outright (even on a clean, already-saved buffer) — you'd have to
 * double-click + expand all over again just to glance back at a cell you'd
 * already finished editing. Instead, `parkedRef` (a plain `Map`, not Zustand —
 * nothing outside this component needs to observe it) keeps one buffer per
 * owning tab id, snapshotted the instant you navigate away and restored the
 * instant you come back, so re-visiting a tab lands you exactly where you
 * left it — saved or not. This scales to many open tabs for free: at most one
 * Monaco instance is ever mounted (this component itself), the map just holds
 * plain strings for whichever tabs you've touched, and closing a tab sweeps
 * its entry so the map can't outlive what it describes.
 *
 * The store's `target` is still the single cross-component signal for "open
 * this cell now" (`DataGrid`'s expand affordance, `CellEditor`'s "move to
 * side" button) — see the effect below keyed on it. It only ever changes in
 * response to that signal, so it's a separate concern from tab-switch
 * restore/park, which is keyed on `useTabs`'s `activeId` instead; the two
 * effects never fight over the same trigger.
 *
 * NOTE: we never call `window.confirm`/`alert` here — Tauri's webview blocks
 * the native dialogs ("dialog.confirm not allowed"), so the unsaved-changes
 * guard uses an in-app `Dialog` instead.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Maximize2, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CellEditorBody } from "@/components/grid/dialogs/CellEditor";
import { useCellEditor, type CellEditorTarget } from "@/stores/grid/cellEditor";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import { useTabs, useTabsIgnoringQuery } from "@/stores/session/tabs";
import {
  detectLanguage,
  type ContentLanguage,
} from "@/lib/grid/detectContentType";
import { autoFormatOnOpen } from "@/lib/grid/autoFormat";
import {
  usePreferences,
  selectEditorPrefs,
} from "@/stores/preferences/preferences";
import { useConnections } from "@/stores/session/connections";
import { resolveConnectionDriver } from "@/lib/connectionLabel";
import { useFullscreenToggle } from "@/lib/useFullscreenToggle";
import { useJsonSchemas, relationKey } from "@/stores/jsonSchemas";

/** Key for a target with no owning tab (an ad-hoc grid with no tab identity)
 *  — at most one such session, matching the pre-existing single-slot
 *  behaviour for that edge case. */
const NO_OWNER = "__no_owner__";

/** A parked, off-screen editing session: enough to resume exactly as left,
 *  without keeping its Monaco instance alive. */
interface ParkedSession {
  target: CellEditorTarget;
  value: string;
  language: ContentLanguage;
  /** Baseline to detect unsaved edits, carried over so dirtiness survives
   *  the round trip through the park. */
  original: string;
}

export function SideEditorPanel() {
  const { t } = useTranslation();
  // The store's "open this cell now" signal — see the file header. Renamed
  // from the bare `target` of the single-slot design to make clear it's a
  // request, not necessarily what's currently on screen (a tab switch can
  // show a restored session without this ever changing).
  const requested = useCellEditor((s) => s.target);
  const closeStore = useCellEditor((s) => s.close);
  // The open-tabs list, so parked sessions can be swept when their owning tab
  // closes, and the active id, so we know which tab's session to show.
  const tabs = useTabsIgnoringQuery();
  const activeId = useTabs((s) => s.activeId);
  // Derive from raw state (gotcha #1) — the same "is there a schema actually
  // resolved for this column" check `CellEditorBody` does for its `resolved`,
  // read here (not just there) so `loadFresh` can use it to decide the
  // initial language instead of the mere presence of `binding` coordinates.
  const resolvedAll = useJsonSchemas((s) => s.resolved);

  /** The session actually being displayed right now — a fresh `open()` or a
   *  restored park, never both sources at once. */
  const [target, setTarget] = useState<CellEditorTarget | null>(null);
  const [value, setValue] = useState("");
  const [language, setLanguage] = useState<ContentLanguage>("plaintext");
  /** Bumped on every load/restore so Monaco remounts with a fresh, empty undo
   *  stack — otherwise Ctrl+Z would reach back into a previous session's
   *  value since this panel reuses one editor across cells and tabs. */
  const [editorKey, setEditorKey] = useState(0);
  const [saving, setSaving] = useState(false);
  /** Re-entrancy guard for the Ctrl+S handler — `setSaving` is async so we
   *  can't rely on the `saving` state inside the keydown listener. */
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** A target the user clicked while the buffer had unsaved edits (same tab,
   *  a different cell); drives the discard-confirmation dialog. Tab switches
   *  never go through this path — they park instead of discarding. */
  const [pendingTarget, setPendingTarget] = useState<CellEditorTarget | null>(
    null,
  );

  /** One buffer per owning tab id, keyed the same way `target.ownerId` is.
   *  Deliberately a ref, not store state: nothing outside this component
   *  ever needs to read it, and mirroring it into Zustand on every keystroke
   *  would make the "is this a fresh open() or just me typing" distinction
   *  in the effect below ambiguous (a store write either way looks like the
   *  target object changed). */
  const parkedRef = useRef<Map<string, ParkedSession>>(new Map());
  /** Which owner key is currently on screen, so the tab-switch effect knows
   *  what to snapshot before swapping. */
  const shownOwnerRef = useRef<string>(NO_OWNER);
  /** The target currently loaded into the buffer (mirrors `target` for
   *  synchronous reads inside effects/keydown handlers). */
  const loadedTargetRef = useRef<CellEditorTarget | null>(null);
  /** Baseline to detect unsaved edits: the value as last loaded/saved. */
  const baselineRef = useRef<string>("");
  /**
   * Live mirrors of `value`/`language`. Assigned on every render (not in an
   * effect) so a synchronous reader — the tab-switch park, the Ctrl+S
   * handler — always sees the latest typed text, not whatever the effect
   * that registered the reader last closed over.
   */
  const valueRef = useRef("");
  valueRef.current = value;
  const languageRef = useRef<ContentLanguage>(language);
  languageRef.current = language;

  /** Load a freshly *requested* target (via `open()`): seed the buffer from
   *  its initial value and detect the language, same as opening any new
   *  cell always has. */
  function loadFresh(next: CellEditorTarget) {
    loadedTargetRef.current = next;
    const raw = next.value ?? "";
    // A *resolved* schema binding is the signal that this column holds JSON,
    // so it wins over the heuristic — see the same call in the modal
    // `CellEditor`. The mere presence of `next.binding` (coordinates only, no
    // confirmed schema) is not enough — that used to force JSON mode on
    // almost every cell of a real table.
    const hasResolvedSchema = next.binding
      ? !!resolvedAll[
          relationKey(
            next.binding.connectionId,
            next.binding.dbSchema,
            next.binding.table,
          )
        ]?.[next.binding.column]
      : false;
    const lang = hasResolvedSchema ? "json" : detectLanguage(raw);
    // Auto-format on open, unless this is a live buffer being handed over.
    //
    // The stores are read imperatively rather than through hooks because
    // `loadFresh` is a one-shot imperative load that itself sets `target` — a
    // subscription keyed on the target it is in the middle of installing is a
    // render-order tangle for a value that is only ever needed right here.
    const seed = next.preformatted
      ? raw
      : autoFormatOnOpen(
          raw,
          lang,
          selectEditorPrefs(usePreferences.getState()),
          resolveConnectionDriver(
            useConnections.getState().profiles,
            next.binding?.connectionId ?? "",
          ),
        );
    // The FORMATTED text is the baseline, not the raw value. That is what
    // makes opening a cell not count as an edit: `valueRef !== baselineRef` is
    // false straight after this, so no unsaved-changes guard fires on close
    // and no discard prompt fires when the user clicks the next cell. The
    // trade is explicit — saving afterwards writes the formatted text — which
    // is why `autoFormatOnOpen` refuses any reformat that moved more than
    // whitespace.
    baselineRef.current = seed;
    setTarget(next);
    setValue(seed);
    setLanguage(lang);
    setEditorKey((k) => k + 1);
  }

  /** Restore a parked session exactly as it was left — including whatever
   *  language the user picked and whatever text they'd typed, saved or not.
   *
   *  Deliberately does NOT auto-format, and the asymmetry with `loadFresh` is
   *  the point rather than an oversight: this restores a buffer the user was
   *  already working in. Re-running the formatter would reindent text they had
   *  hand-edited, and `formatXml` is not idempotent, so a session parked and
   *  restored a few times would drift further each round. */
  function restoreParked(parked: ParkedSession) {
    loadedTargetRef.current = parked.target;
    baselineRef.current = parked.original;
    setTarget(parked.target);
    setValue(parked.value);
    setLanguage(parked.language);
    setEditorKey((k) => k + 1);
  }

  /** Nothing parked for this tab — show the empty hint. */
  function clearDisplay() {
    loadedTargetRef.current = null;
    setTarget(null);
  }

  // React to a fresh open() request (the grid's expand affordance, or the
  // modal's "move to side"). Only fires when someone actually calls `open()`
  // — a tab switch never touches `requested`, so this can't fire spuriously
  // when the effect below restores a park instead.
  useEffect(() => {
    if (!requested) return;
    if (requested === loadedTargetRef.current) return;
    const dirty =
      loadedTargetRef.current !== null &&
      valueRef.current !== baselineRef.current;
    if (dirty) {
      setPendingTarget(requested);
      return;
    }
    loadFresh(requested);
    // `value`/`language` intentionally excluded — read live via the refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested]);

  // Follow the active tab: park the outgoing tab's buffer (whatever state
  // it's in, saved or not) and restore — or, if nothing was ever opened
  // there, clear — whatever the incoming tab last had open. The split's own
  // visibility follows suit, so switching tabs never leaves it showing a
  // different tab's cell.
  useEffect(() => {
    const incomingKey = activeId ?? NO_OWNER;
    const outgoingKey = shownOwnerRef.current;
    if (incomingKey === outgoingKey) return;
    shownOwnerRef.current = incomingKey;

    if (loadedTargetRef.current) {
      parkedRef.current.set(outgoingKey, {
        target: loadedTargetRef.current,
        value: valueRef.current,
        language: languageRef.current,
        original: baselineRef.current,
      });
    }

    const incoming = parkedRef.current.get(incomingKey);
    if (incoming) {
      restoreParked(incoming);
      useSessionPanelLayout.getState().openSideEditor();
    } else {
      clearDisplay();
      useSessionPanelLayout.getState().closeSideEditor();
    }
    setPendingTarget(null);
    setSaveError(null);
  }, [activeId]);

  // Sweep parked sessions (and the on-screen one) whose owning tab was
  // closed — the side editor lives outside the tab's own subtree, so without
  // this a closed tab's session lingers in `parkedRef` forever, holding a
  // stale `onSave` closure over a table that's no longer open.
  useEffect(() => {
    const validIds = new Set(tabs.map((tb) => tb.id));
    for (const key of parkedRef.current.keys()) {
      if (key !== NO_OWNER && !validIds.has(key)) parkedRef.current.delete(key);
    }
    const owner = loadedTargetRef.current?.ownerId;
    if (owner && !validIds.has(owner)) {
      clearDisplay();
      useSessionPanelLayout.getState().closeSideEditor();
    }
  }, [tabs]);

  // Ctrl/Cmd+S saves the buffer *in place*: persist the edits, reset the
  // dirty baseline, and keep the panel (and its parked entry) open so the
  // user can move to another cell — or another tab — without the discard
  // guard firing. Registered in the capture phase with
  // `stopImmediatePropagation` so it wins over the floating CellPreview's
  // own window-level Ctrl+S — which otherwise persists its stale, pre-edit
  // value and leaves this panel dirty. Bails (letting other handlers run)
  // when no editable cell is loaded here.
  useEffect(() => {
    async function onKey(e: KeyboardEvent) {
      if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s")) return;
      const tgt = loadedTargetRef.current;
      if (!tgt || tgt.readonly || !tgt.onSave) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      setSaveError(null);
      try {
        const v = valueRef.current;
        await tgt.onSave(v);
        baselineRef.current = v;
      } catch (err) {
        setSaveError(t("cellEditor.saveFailed", { message: String(err) }));
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [t]);

  // Only active while a cell is loaded — with no target the panel shows the
  // empty hint and there is nothing to expand. Gated on the *ref* so a keypress
  // consults the current target, not one captured at subscribe time.
  const [fullscreen, setFullscreen] = useFullscreenToggle(
    () => !!loadedTargetRef.current,
  );
  // Leaving the cell (Save, Discard, the split closing) also leaves full
  // screen, or the next cell opened would start maximised with no gesture of
  // the user's asking for it.
  useEffect(() => {
    if (!target) setFullscreen(false);
  }, [target, setFullscreen]);

  if (!target) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        {t("cellEditor.sideEmpty")}
      </div>
    );
  }

  const readonly = target.readonly || !target.onSave;
  const ownerKey = target.ownerId ?? NO_OWNER;

  /** "Guardar"/"Descartar" both mean "I'm done with this cell for now" —
   *  unlike Ctrl+S, they forget the parked session, clear the display, and
   *  close the split. */
  function forgetSession() {
    parkedRef.current.delete(ownerKey);
    clearDisplay();
    setPendingTarget(null);
    closeStore();
  }

  async function handleSave() {
    if (!target?.onSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await target.onSave(value);
      forgetSession();
    } catch (e) {
      setSaveError(t("cellEditor.saveFailed", { message: String(e) }));
    } finally {
      setSaving(false);
    }
  }

  const panel = (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col gap-2 p-2",
        fullscreen && "fixed inset-0 z-50 bg-background",
      )}
    >
      <div className="flex items-center gap-2 px-1">
        <span className="truncate text-xs font-semibold">
          {target.columnName || t("cellEditor.title")}
        </span>
        <span className="text-2xs text-muted-foreground">
          {t("cellEditor.chars", { count: value.length })}
        </span>
        <IconButton
          size="xs"
          icon={fullscreen ? Minimize2 : Maximize2}
          label={
            fullscreen
              ? t("cellEditor.exitFullscreen")
              : t("cellEditor.fullscreen")
          }
          className="ml-auto"
          onClick={() => setFullscreen((v) => !v)}
        />
      </div>
      <CellEditorBody
        value={value}
        onChange={setValue}
        language={language}
        onLanguageChange={setLanguage}
        readonly={readonly}
        surface="side"
        binding={target?.binding}
        editorKey={editorKey}
      />
      {saveError && (
        <div className="px-1 text-2xs text-destructive">{saveError}</div>
      )}
      <div className="flex justify-end gap-2 px-1">
        <Button variant="outline" size="sm" onClick={forgetSession}>
          {readonly ? t("common.close") : t("cellEditor.discard")}
        </Button>
        {!readonly && (
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? t("cellEditor.saving") : t("common.save")}
          </Button>
        )}
      </div>

      {/* Unsaved-changes guard when opening a different cell in the SAME tab
          (a tab switch never reaches this — it parks instead of discarding). */}
      <Dialog
        open={!!pendingTarget}
        onOpenChange={(open) => {
          if (!open) {
            // Cancel: stay on the current cell. Re-pin the loaded target in the
            // store so a later click on the same new cell prompts again.
            if (loadedTargetRef.current) {
              useCellEditor.getState().open(loadedTargetRef.current);
            }
            setPendingTarget(null);
          }
        }}
      >
        <DialogContent tier="prompt">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {t("cellEditor.discardChangesTitle")}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-xs text-muted-foreground">
              {t("cellEditor.discardChangesConfirm")}
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (loadedTargetRef.current) {
                  useCellEditor.getState().open(loadedTargetRef.current);
                }
                setPendingTarget(null);
              }}
            >
              {t("cellEditor.keepEditing")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (pendingTarget) loadFresh(pendingTarget);
                setPendingTarget(null);
              }}
            >
              {t("cellEditor.discardAndSwitch")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );

  // Full screen has to leave the side split's DOM, not just restyle in place:
  // `CollapsiblePanel` wraps this in `contain: layout style`, and layout
  // containment makes that wrapper the containing block of every `fixed`
  // descendant — so `fixed inset-0` covered exactly the panel it was already
  // in, and the button changed its icon while nothing on screen moved. A portal
  // to `body` is the one ancestor with no containment. The editing session
  // survives the move: its state lives in this component, which stays mounted;
  // only the subtree below is re-created in its new place.
  return fullscreen ? createPortal(panel, document.body) : panel;
}
