/**
 * Teams-style environment rail — replaces the old lone "Schema" button in
 * the left activity bar. One avatar (initials over its accent colour, see
 * `EnvironmentAvatar`) per environment with its name underneath, plus a
 * trailing "+" to create a new one. This is the left activity bar's only
 * content now: there is no separate generic "Schema" toggle button —
 * clicking the *already active* environment's avatar is what collapses/
 * expands the Schema panel, since a second dedicated button would be
 * redundant with it.
 *
 * Clicking a non-active environment switches to it (`switchTo`, same
 * teardown/reconnect operation `EnvironmentSwitcher` already drives) AND
 * opens the Schema panel if it was closed — one gesture for "I want to work
 * in this environment", per the user's explicit choice over "switch only".
 *
 * Right-clicking an avatar opens the same rename/delete actions
 * `EnvironmentSwitcher`'s dropdown rows offer — the rail is the primary
 * place users now interact with environments, so it needs the same context
 * menu the status-bar switcher already had rather than forcing a trip there
 * for management.
 *
 * Rendered in every window, but only the main window gets the management
 * affordances (create, rename, delete, reorder): those write `tab_state.json`
 * (ADR #8), which secondary "New window" instances never touch. A
 * secondary window still renders one plain, non-draggable button per
 * environment — clicking one calls `useEnvironments.switchTo`, which for a
 * non-main window resolves to a purely local, in-memory filter change (see
 * that store's `applyLocalView`), letting each window sit in a different
 * environment at once.
 *
 * The rail is two zones: the environments scroll (`.rail-scroll`, its
 * scrollbar hidden — 10px of the global skin on a 72px rail would land on
 * the avatars), and a pinned strip below them holding "+", Theme and
 * Settings. Those three must stay reachable at any environment count, which
 * `mt-auto` alone could not guarantee: it pins to the bottom only while
 * there is slack, so past ~8 environments the footer was pushed out of the
 * rail and clipped by `AppShell`'s `overflow-hidden`.
 *
 * Reorderable via `@dnd-kit` (vertical sortable list, main window only) —
 * drag an avatar to move it, drop to persist through `useEnvironments.reorder`,
 * which already writes optimistically and rolls back on a failed
 * `reorderEnvironments` call. `EnvironmentSwitcher`'s dropdown rows are not
 * draggable; this rail is the one place order can be changed.
 */

import { Spinner } from "@/components/ui/spinner";
import { EnvironmentAvatar } from "@/components/connection/EnvironmentAvatar";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api } from "@/lib/tauri";
import { notify } from "@/lib/notify";
import { useEnvironmentEditor } from "@/stores/dialogs/environmentEditor";
import { useEnvironmentDeleteConfirm } from "@/stores/dialogs/environmentDeleteConfirm";
import {
  effectiveColor,
  effectiveIcon,
  environmentLabel,
  useEnvironments,
  useOrderedEnvironments,
} from "@/stores/session/environments";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import type { Environment } from "@/types";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { isMainWindow } from "@/lib/window";
import { AppWindow, Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface EnvironmentRailProps {
  /** Chrome-level buttons (Theme/Settings) pinned to the bottom, same slot
   *  `ActivityBar`'s own `footer` prop offers. */
  footer?: ReactNode;
}

export function EnvironmentRail({ footer }: EnvironmentRailProps) {
  const { t } = useTranslation();
  const activeId = useEnvironments((s) => s.activeId);
  const switchingTo = useEnvironments((s) => s.switchingTo);
  const switchTo = useEnvironments((s) => s.switchTo);
  const lastReplicate = useEnvironments((s) => s.lastReplicate);
  const reorder = useEnvironments((s) => s.reorder);
  const openCreate = useEnvironmentEditor((s) => s.openCreate);
  const openEdit = useEnvironmentEditor((s) => s.openEdit);
  const openDeleteConfirm = useEnvironmentDeleteConfirm((s) => s.open);

  const schemaOpen = useSessionPanelLayout((s) => s.schemaOpen);
  const toggleSchema = useSessionPanelLayout((s) => s.toggleSchema);
  const openSchema = useSessionPanelLayout((s) => s.openSchema);

  const ordered = useOrderedEnvironments();
  const orderedIds = useMemo(() => ordered.map((e) => e.id), [ordered]);

  const defaultName = t("environments.defaultName");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Only the main window may create/rename/delete/reorder — those write
  // `tab_state.json` (ADR #8). A secondary window still gets the rail
  // itself, in a read-only, non-draggable form (see the render below).
  const isMain = isMainWindow();

  function handleClick(envId: string) {
    if (envId === activeId) {
      toggleSchema();
      return;
    }
    openSchema();
    void switchTo(envId);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = orderedIds.indexOf(String(active.id));
    const newIndex = orderedIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const next = [...orderedIds];
    next.splice(oldIndex, 1);
    next.splice(newIndex, 0, String(active.id));
    void reorder(next);
  }

  return (
    // Two zones, not one flat column: the environments scroll, the chrome
    // below them does not. The footer used to be pinned with `mt-auto`, which
    // only holds while there is slack — past ~8 environments on a 1080p
    // display the list overflowed, pushed Theme/Settings past the rail's
    // bottom edge, and `AppShell`'s `overflow-hidden` clipped them away with
    // no scroll to reach them.
    <div className="flex w-[72px] shrink-0 flex-col border-r border-border">
      {/* `min-h-0` is load-bearing: a flex child defaults to `min-height:auto`,
          which refuses to shrink below its content, so the scrollbar would
          never appear and the overflow would keep escaping the rail. */}
      <div className="rail-scroll flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto py-2">
        {isMain ? (
          <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
            <SortableContext
              items={orderedIds}
              strategy={verticalListSortingStrategy}
            >
              {ordered.map((env) => (
                <SortableEnvironmentButton
                  key={env.id}
                  env={env}
                  label={environmentLabel(env, defaultName)}
                  isActive={env.id === activeId}
                  schemaOpen={schemaOpen}
                  switchingTo={switchingTo}
                  canDelete={ordered.length > 1 && !env.originId}
                  onClick={() => handleClick(env.id)}
                  onRename={() =>
                    openEdit({
                      id: env.id,
                      name: environmentLabel(env, ""),
                      color: effectiveColor(env),
                      icon: effectiveIcon(env),
                      themeId: env.localThemeId ?? env.themeId ?? null,
                      originId: env.originId ?? null,
                    })
                  }
                  onOpenInNewWindow={() => {
                    void api.openNewWindow(null, env.id).catch((e) => {
                      notify.error(t("menu.window.newWindowFailed"), {
                        description: String(e),
                      });
                    });
                  }}
                  onDelete={() =>
                    openDeleteConfirm(
                      env.id,
                      environmentLabel(env, defaultName),
                    )
                  }
                  renameLabel={t("environments.rename")}
                  openInNewWindowLabel={t("environments.openInNewWindow")}
                  deleteLabel={t("environments.delete")}
                />
              ))}
            </SortableContext>
          </DndContext>
        ) : (
          // Secondary window: plain, non-draggable buttons — picking one only
          // changes this window's own connection/database filter (see
          // `useEnvironments.switchTo`'s non-main branch), so there is nothing
          // here that needs drag-to-reorder or a rename/delete context menu.
          ordered.map((env) => (
            <EnvironmentButton
              key={env.id}
              env={env}
              label={environmentLabel(env, defaultName)}
              isActive={env.id === activeId}
              schemaOpen={schemaOpen}
              switchingTo={switchingTo}
              onClick={() => handleClick(env.id)}
            />
          ))
        )}
      </div>
      {/* Pinned chrome. "+" lives here rather than at the end of the scrolling
          list so creating an environment never requires scrolling to the
          bottom of the environments you already have. */}
      <div className="flex shrink-0 flex-col items-center gap-2 border-t border-border py-2">
        {isMain && (
          <SimpleTooltip label={t("environments.create")} side="right">
            <button
              type="button"
              onClick={() => openCreate(lastReplicate)}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors duration-150 hover:border-brand/60 hover:bg-brand/10 hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <Plus className="h-[18px] w-[18px]" />
            </button>
          </SimpleTooltip>
        )}
        {footer && (
          <div className="flex flex-col items-center gap-0.5">{footer}</div>
        )}
      </div>
    </div>
  );
}

interface EnvironmentButtonProps {
  env: Environment;
  label: string;
  isActive: boolean;
  schemaOpen: boolean;
  /** The environment being switched *to*, or `null`. See the store's field. */
  switchingTo: string | null;
  onClick: () => void;
}

/**
 * Read-only counterpart to `SortableEnvironmentButton`, for secondary
 * windows: same look, no drag handle and no context menu (rename/delete write
 * `tab_state.json`, main-window only).
 */
function EnvironmentButton({
  env,
  label,
  isActive,
  schemaOpen,
  switchingTo,
  onClick,
}: EnvironmentButtonProps) {
  // Every row is disabled while any switch is in flight, but only the row being
  // travelled *to* shows the spinner. Those are two different questions and
  // `switching && isActive` answered the second one with the first.
  const busy = switchingTo !== null;
  const isTarget = switchingTo === env.id;
  return (
    <SimpleTooltip label={label} side="right">
      <button
        type="button"
        disabled={busy}
        onClick={onClick}
        aria-pressed={isActive && schemaOpen}
        className={cn(
          // `shrink-0`: in the rail's scrolling flex column the buttons would
          // otherwise compress to fit instead of overflowing into the scroll.
          "group relative flex w-full shrink-0 flex-col items-center gap-1 rounded-md px-1 py-1 transition-colors duration-150 disabled:opacity-60",
          "hover:bg-accent",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
          isActive && "bg-accent/60",
        )}
      >
        {isActive && (
          <span
            aria-hidden
            // Same 4px marker, same geometry as `SortableEnvironmentButton` —
            // this read-only twin must not drift from it. At `-left-2` on a
            // full-width button the bar lands outside the shell's
            // `overflow-hidden` and never paints at all.
            className="absolute left-0 top-1 bottom-1 w-1 rounded-full"
            style={{ backgroundColor: effectiveColor(env) || "var(--brand)" }}
          />
        )}
        {isTarget ? (
          <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-muted">
            <Spinner size="lg" className="text-muted-foreground" />
          </div>
        ) : (
          <EnvironmentAvatar
            name={label}
            color={effectiveColor(env)}
            icon={effectiveIcon(env)}
            size={36}
          />
        )}
        <span
          className={cn(
            "w-full truncate text-center text-2xs leading-[1.15] tracking-tight text-muted-foreground",
            isActive && "font-medium text-foreground",
          )}
        >
          {label}
        </span>
      </button>
    </SimpleTooltip>
  );
}

interface SortableEnvironmentButtonProps {
  env: Environment;
  label: string;
  isActive: boolean;
  schemaOpen: boolean;
  /** The environment being switched *to*, or `null`. See the store's field. */
  switchingTo: string | null;
  /** A mirrored environment (#108) can't be deleted here — that would just be
   *  reported vanished on the next sync and re-created, never destroy the
   *  publisher's copy — so this is false whenever `env.originId` is set,
   *  released only via the vanished-environment notice's adopt/retire.
   *  Renaming/recolouring has no such restriction: `EnvironmentEditorDialog`
   *  writes a local override instead of the synced field when the target is
   *  mirrored, so it's always available. */
  canDelete: boolean;
  onClick: () => void;
  onRename: () => void;
  /** Open this environment in a new window without leaving the current one.
   *  Available for every environment, mirrored ones included, and while a
   *  switch is running: it never touches the session being rebuilt. */
  onOpenInNewWindow: () => void;
  onDelete: () => void;
  renameLabel: string;
  openInNewWindowLabel: string;
  deleteLabel: string;
}

function SortableEnvironmentButton({
  env,
  label,
  isActive,
  schemaOpen,
  switchingTo,
  canDelete,
  onClick,
  onRename,
  onOpenInNewWindow,
  onDelete,
  renameLabel,
  openInNewWindowLabel,
  deleteLabel,
}: SortableEnvironmentButtonProps) {
  // See `EnvironmentButton`: disabled is "a switch is running", the spinner is
  // "this is where we are going". They are not the same row.
  const busy = switchingTo !== null;
  const isTarget = switchingTo === env.id;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: env.id });

  const style = {
    // X is zeroed deliberately. The rail scrolls now, and a scroll container
    // clips both axes (`overflow-y: auto` forces the other axis to `auto`
    // too), so a drag that drifts sideways would slice the avatar against the
    // rail's edge. The list is vertical anyway — dropping the horizontal
    // component costs nothing and keeps the dragged item whole.
    transform: CSS.Transform.toString(transform && { ...transform, x: 0 }),
    transition,
  };

  return (
    <ContextMenu>
      <SimpleTooltip label={label} side="right">
        <ContextMenuTrigger asChild>
          <button
            ref={setNodeRef}
            style={style}
            {...attributes}
            {...listeners}
            type="button"
            disabled={busy}
            onClick={onClick}
            aria-pressed={isActive && schemaOpen}
            className={cn(
              // See `EnvironmentButton` on `shrink-0` — the rail scrolls, and
              // without it the avatars squash instead of overflowing.
              "group relative flex w-full shrink-0 flex-col items-center gap-1 rounded-md px-1 py-1 transition-colors duration-150 disabled:opacity-60",
              "hover:bg-accent",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
              isActive && "bg-accent/60",
              isDragging && "z-10 opacity-80",
            )}
          >
            {isActive && (
              <span
                aria-hidden
                // Same 4px active marker as `ActivityBar`, in the environment's
                // own colour (its identity outranks the brand blue here) and
                // flush against the rail's left edge. It sat at `-left-2` while
                // the button spans the rail's full width, which put a 2px
                // sliver outside the shell's `overflow-hidden` — invisible.
                className="absolute left-0 top-1 bottom-1 w-1 rounded-full"
                style={{
                  backgroundColor: effectiveColor(env) || "var(--brand)",
                }}
              />
            )}
            {isTarget ? (
              <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-muted">
                <Spinner size="lg" className="text-muted-foreground" />
              </div>
            ) : (
              <EnvironmentAvatar
                name={label}
                color={effectiveColor(env)}
                icon={effectiveIcon(env)}
                size={36}
              />
            )}
            {/* 11px rather than the 10px this started at: the rail is 72px
                wide, so the label is the one piece of chrome that has to stay
                readable at a glance from the corner of the eye, and 10px sat
                below that on a 1080p display. Tighter tracking keeps roughly
                the same number of glyphs fitting before the truncation, and the
                active row goes medium so "which environment am I in" reads from
                the weight, not only from the background tint. */}
            <span
              className={cn(
                "w-full truncate text-center text-2xs leading-[1.15] tracking-tight text-muted-foreground",
                isActive && "font-medium text-foreground",
              )}
            >
              {label}
            </span>
          </button>
        </ContextMenuTrigger>
      </SimpleTooltip>
      <ContextMenuContent className="w-48 text-xs">
        <ContextMenuItem onSelect={onRename}>
          <Pencil className="mr-2 h-3.5 w-3.5" />
          {renameLabel}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onOpenInNewWindow}>
          <AppWindow className="mr-2 h-3.5 w-3.5" />
          {openInNewWindowLabel}
        </ContextMenuItem>
        {canDelete && (
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={onDelete}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            {deleteLabel}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
