/**
 * Status-bar dropdown for switching, creating, renaming and deleting
 * environments. Lives in the bottom-left corner, next to `StatusConnections`,
 * so both "what's in play" controls sit together rather than splitting one
 * into the topbar and one into the status bar.
 *
 * Rendered in every window. In the main window, switching tears down every
 * live pool and rebuilds the incoming session, which takes as long as
 * reconnecting does — the trigger reflects `switching` (spinner, disabled)
 * rather than looking instantaneous and leaving the user clicking again
 * mid-teardown. In a secondary "New window" instance, `switchTo` resolves to a
 * purely local filter change instead (ADR #8 — it never touches
 * `tab_state.json`), so create/rename/delete are hidden there: those are the
 * actions that do write it.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Check, Download, Pencil, Plus, Trash2 } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { isMainWindow } from "@/lib/window";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import {
  effectiveColor,
  effectiveIcon,
  environmentLabel,
  useEnvironments,
  useOrderedEnvironments,
} from "@/stores/session/environments";
import { useEnvironmentEditor } from "@/stores/dialogs/environmentEditor";
import { useEnvironmentTransfer } from "@/stores/dialogs/environmentTransfer";
import { useEnvironmentDeleteConfirm } from "@/stores/dialogs/environmentDeleteConfirm";
import { isAvatarImage } from "@/lib/environmentAvatar";
import { cn } from "@/lib/utils";
import type { Environment } from "@/types";

export function EnvironmentSwitcher() {
  const { t } = useTranslation();
  // Primitive / raw-state selectors only (gotcha #1) — the sorted list is
  // derived below with useMemo so its identity stays stable.
  const environments = useEnvironments((s) => s.environments);
  const activeId = useEnvironments((s) => s.activeId);
  const switchingTo = useEnvironments((s) => s.switchingTo);
  const switchTo = useEnvironments((s) => s.switchTo);
  const lastReplicate = useEnvironments((s) => s.lastReplicate);

  const openCreate = useEnvironmentEditor((s) => s.openCreate);
  const openEdit = useEnvironmentEditor((s) => s.openEdit);
  const openExport = useEnvironmentTransfer((s) => s.openExport);
  const openDeleteConfirm = useEnvironmentDeleteConfirm((s) => s.open);

  const ordered = useOrderedEnvironments();
  const active = useMemo(
    () => environments.find((e) => e.id === activeId) ?? null,
    [environments, activeId],
  );

  const defaultName = t("environments.defaultName");
  const isMain = isMainWindow();

  // Nothing useful to show before the first load resolves.
  if (!active) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={switchingTo !== null}
          className={cn(
            "flex max-w-[10rem] items-center gap-1.5 rounded-sm px-1 py-0.5 outline-none transition-colors",
            "hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
          )}
          title={t("environments.switcherTooltip")}
        >
          {switchingTo !== null ? (
            <Spinner size="xs" className="shrink-0" />
          ) : (
            <EnvironmentMark env={active} />
          )}
          <span className="truncate">
            {environmentLabel(active, defaultName)}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64">
        {ordered.map((env) => {
          const isActive = env.id === activeId;
          return (
            <DropdownMenuItem
              key={env.id}
              className="group/env gap-2"
              // Radix closes on select; `switchTo` is async and no-ops when
              // the id is already active.
              onSelect={() => void switchTo(env.id)}
            >
              <Check
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  isActive ? "opacity-100" : "opacity-0",
                )}
              />
              <EnvironmentMark env={env} />
              <span className="min-w-0 flex-1 truncate">
                {environmentLabel(env, defaultName)}
              </span>
              {/* A mirrored environment's connection membership is read-only
                  (the next sync overwrites it), but its cosmetics are not —
                  editing one here writes a local override instead of the
                  synced field, see `EnvironmentEditorDialog`. */}
              {isMain && (
                <span
                  role="button"
                  tabIndex={-1}
                  className="shrink-0 opacity-0 group-hover/env:opacity-70 hover:!opacity-100"
                  title={t("environments.rename")}
                  onClick={(e) => {
                    // Keep the menu open and don't trigger the row's switch.
                    e.preventDefault();
                    e.stopPropagation();
                    openEdit({
                      id: env.id,
                      name: environmentLabel(env, ""),
                      color: effectiveColor(env),
                      icon: effectiveIcon(env),
                      themeId: env.localThemeId ?? env.themeId ?? null,
                      originId: env.originId ?? null,
                    });
                  }}
                >
                  <Pencil className="h-3 w-3" />
                </span>
              )}
              {isMain && (
                <span
                  role="button"
                  tabIndex={-1}
                  className="shrink-0 opacity-0 group-hover/env:opacity-70 hover:!opacity-100"
                  title={t("environments.export")}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openExport([env.id]);
                  }}
                >
                  <Download className="h-3 w-3" />
                </span>
              )}
              {isMain && ordered.length > 1 && !env.originId && (
                <span
                  role="button"
                  tabIndex={-1}
                  className="shrink-0 opacity-0 group-hover/env:opacity-70 hover:!opacity-100"
                  title={t("environments.delete")}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openDeleteConfirm(
                      env.id,
                      environmentLabel(env, defaultName),
                    );
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
        {isMain && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="gap-2"
              onSelect={() => openCreate(lastReplicate)}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("environments.create")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Status-bar-scale mark for an environment: its avatar image when it has one,
 * otherwise the accent-colour dot this has always used.
 *
 * Not `EnvironmentAvatar` — initials are illegible at 8–12px, which is why the
 * dot exists in the first place. An image is not: a recognisable thumbnail is
 * exactly what the user uploaded it for, so honouring it here keeps the status
 * bar consistent with the rail instead of showing a generic dot for an
 * environment the user gave a face.
 */
function EnvironmentMark({ env }: { env: Environment }) {
  const icon = effectiveIcon(env);
  if (isAvatarImage(icon)) {
    return (
      <img
        src={icon}
        alt=""
        aria-hidden
        draggable={false}
        className="h-3 w-3 shrink-0 rounded-[3px] object-cover"
      />
    );
  }
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-full"
      style={{
        backgroundColor: effectiveColor(env) || "var(--muted-foreground)",
      }}
    />
  );
}
