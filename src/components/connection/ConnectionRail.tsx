/**
 * Left rail of the connection manager: the saved connections, filterable by
 * provenance, searchable and grouped, plus the multi-selection and its bulk
 * delete.
 *
 * The contract with the editor beside it is still just "which profile is being
 * edited" — `editingId` in, `onEdit` out. Everything else (the scope, the search
 * term, the selection, the section folds) is rail-local and was never read by
 * the form. It also does not need resetting on close: Radix unmounts
 * `DialogContent`, so the rail remounts with its initial state every time the
 * manager is opened.
 *
 * ## Two axes, one order
 *
 * Provenance (local vs. which shared origin published it, #108) is the outer
 * axis; the free-text `group` folder is the inner one. `buildRailSections` owns
 * that split and the reasoning behind the order. The `Segmented` control at the
 * top filters rather than reorders, and hides itself entirely when nothing here
 * comes from an origin.
 *
 * ## Two id lists, on purpose
 *
 * `visibleIds` skips collapsed groups and collapsed sections, because it is the
 * domain of Shift-range selection — a row nobody can see is not "between" two
 * rows they can. `selectableIds` / `RailSection.ids` are collapse-blind, because
 * they are the domain of select-all, where skipping what is folded would
 * silently miss rows the user believes they just selected. Same family as
 * convention #45: the divergence is the point.
 *
 * ## Selection is not navigation
 *
 * A plain click opens a profile and clears the selection; only a checkbox,
 * Ctrl/Cmd-click or Shift-click builds one. That is what lets the bulk bar
 * appear from a single checked row without flashing on every click, and it lives
 * in `useConnectionRailSelection` so a profile a shared origin publishes cannot
 * enter the set by any route. Deleting connections always confirms, regardless
 * of the "confirm destructive actions" preference.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MoreHorizontal, Plus, Search, Trash2, X } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { IconButton } from "@/components/ui/icon-button";
import { ConnectionRailSection } from "@/components/connection/ConnectionRailSection";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import {
  isFromOrigin,
  originIdOf,
  type ProfileScope,
} from "@/lib/connection/origin";
import { buildRailSections } from "@/lib/connection/railSections";
import { useConnectionGroupCollapse } from "@/lib/connection/useConnectionGroups";
import { useConnectionRailSelection } from "@/lib/connection/useConnectionRailSelection";
import { useOrigins } from "@/stores/sync/origins";
import type { ConnectionProfile } from "@/types";

export function ConnectionRail({
  profiles,
  active,
  editingId,
  onEdit,
  onDeleteRequest,
}: {
  profiles: ConnectionProfile[];
  /** Ids with a live pool — drives the per-row status dot. */
  active: Set<string>;
  /** Profile open in the editor, or `null` for a new draft. */
  editingId: string | null;
  onEdit: (id: string | null) => void;
  /** Hands a batch to the manager's shared delete confirmation. */
  onDeleteRequest: (targets: ConnectionProfile[]) => void;
}) {
  const { t } = useTranslation();

  const [scope, setScope] = useState<ProfileScope>("all");
  const [search, setSearch] = useState("");
  const [foldedSections, setFoldedSections] = useState<Record<string, boolean>>(
    {},
  );
  const groupCollapse = useConnectionGroupCollapse();
  const originsById = useOrigins((s) => s.byId);

  /** Ids the bulk delete can never touch: an origin republishes them. */
  const protectedIds = useMemo(
    () => new Set(profiles.filter(isFromOrigin).map((p) => p.id)),
    [profiles],
  );
  const selection = useConnectionRailSelection(protectedIds);

  // Dropping the editor to a new draft — "New connection", or `onDuplicate`
  // seeding a clone — means the rows below are no longer what is on screen, so
  // the selection goes with it. Ctrl/Shift-click never lands here: those always
  // set an id, so the multi-selection they build is never clobbered.
  useEffect(() => {
    if (editingId === null) selection.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  const searching = search.trim().length > 0;
  const hasShared = protectedIds.size > 0;

  // With no origins registered the filter can only ever have one non-empty
  // answer, so it is dead chrome. The scope resets with it, or removing the last
  // origin would leave the rail stuck on an empty "Shared".
  useEffect(() => {
    if (!hasShared && scope !== "all") setScope("all");
  }, [hasShared, scope]);

  /** Profiles matching the rail search box (name / host / database / group). */
  const filteredProfiles = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return profiles;
    return profiles.filter((p) =>
      [p.name, p.host, p.database, p.group, p.connection_string]
        .filter((x): x is string => !!x)
        .some((x) => x.toLowerCase().includes(term)),
    );
  }, [profiles, search]);

  const nameOf = useMemo(
    () => (originId: string) => originsById[originId]?.name ?? null,
    [originsById],
  );
  const originNameOf = useMemo(
    () => (p: ConnectionProfile) => {
      const id = originIdOf(p);
      return id ? nameOf(id) : null;
    },
    [nameOf],
  );

  const sections = useMemo(
    () =>
      buildRailSections(filteredProfiles, scope, nameOf, {
        shared: (origin) => t("connections.sharedSection", { origin }),
        orphaned: t("connections.orphanedSection"),
      }),
    [filteredProfiles, scope, nameOf, t],
  );

  /** A section's fold key. `originId` is null both for the headerless section
   *  and for the orphaned one, which is the only pair that could collide —
   *  hence the index fallback. */
  const foldKey = (index: number, originId: string | null) =>
    originId ?? `section:${index}`;

  /** Ids in render order, skipping what is folded — the Shift-range domain. */
  const visibleIds = useMemo(() => {
    const ids: string[] = [];
    sections.forEach((s, i) => {
      if (s.label !== null && foldedSections[foldKey(i, s.originId)]) return;
      ids.push(...s.ungrouped.map((p) => p.id));
      for (const g of s.groups) {
        if (!searching && groupCollapse.isCollapsed(g.name)) continue;
        ids.push(...g.items.map((p) => p.id));
      }
    });
    return ids;
  }, [sections, foldedSections, searching, groupCollapse]);

  /** Every local profile passing the search — the select-all domain,
   *  deliberately collapse-blind (see the module doc). */
  const selectableIds = useMemo(
    () => filteredProfiles.filter((p) => !isFromOrigin(p)).map((p) => p.id),
    [filteredProfiles],
  );
  const allLocal = useMemo(
    () => profiles.filter((p) => !isFromOrigin(p)),
    [profiles],
  );

  /** Rail row click: plain = open + drop the selection; Ctrl/Cmd = toggle into
   *  the multi-selection; Shift = range from the last anchor. */
  function onRowClick(id: string, e: React.MouseEvent) {
    if (e.shiftKey) {
      selection.extendTo(id, visibleIds);
      onEdit(id);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      selection.toggle(id);
      onEdit(id);
      return;
    }
    selection.clear();
    onEdit(id);
  }

  const checkedProfiles = useMemo(
    () => profiles.filter((p) => selection.checked.has(p.id)),
    [profiles, selection.checked],
  );

  const scopeOptions = useMemo(
    () => [
      {
        value: "all" as const,
        label: `${t("connections.scope.all")} ${profiles.length}`,
      },
      {
        value: "local" as const,
        label: `${t("connections.scope.local")} ${allLocal.length}`,
      },
      {
        value: "shared" as const,
        label: `${t("connections.scope.shared")} ${protectedIds.size}`,
      },
    ],
    [t, profiles.length, allLocal.length, protectedIds.size],
  );

  const allSelectableChecked =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selection.checked.has(id));

  return (
    <aside className="flex min-h-0 flex-col border-r border-border bg-card/40">
      <div className="px-2 pt-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          onClick={() => onEdit(null)}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("connectionDialog.newConnection")}
        </Button>
      </div>
      {hasShared && (
        <Segmented
          size="sm"
          variant="underline"
          className="mt-2"
          value={scope}
          onValueChange={setScope}
          options={scopeOptions}
          aria-label={t("connections.scopeLabel")}
        />
      )}
      {profiles.length > 0 && (
        <div className="px-2 pt-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("connectionDialog.searchPlaceholder")}
              className="h-8 pl-7 pr-7 text-xs"
            />
            {search && (
              <IconButton
                type="button"
                flat
                size="xs"
                icon={X}
                label={t("common.clear")}
                onClick={() => setSearch("")}
                className="absolute right-1 top-1/2 -translate-y-1/2"
              />
            )}
          </div>
        </div>
      )}
      <div className="mt-1 flex items-center gap-1.5 px-3 py-1">
        {selectableIds.length > 0 && scope !== "shared" && (
          <Checkbox
            size="xs"
            checked={allSelectableChecked}
            onChange={() => selection.toggleAll(selectableIds)}
            aria-label={t("connections.selectAll")}
          />
        )}
        <span className="text-3xs uppercase tracking-wider text-muted-foreground">
          {t("connectionDialog.listTitle")}
        </span>
        {allLocal.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                icon={MoreHorizontal}
                label={t("connections.listActions")}
                className="ml-auto"
                type="button"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuItem
                // With a filter active "all local" is ambiguous — the filtered
                // ones, or every one? — and guessing wrong deletes connections
                // the user never saw. The checkboxes already cover that case,
                // where what will go is on screen.
                disabled={searching}
                title={
                  searching
                    ? t("connections.deleteAllLocalNeedsClearSearch")
                    : undefined
                }
                onSelect={() => onDeleteRequest(allLocal)}
                className="text-destructive"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                {t("connections.deleteAllLocal")} ({allLocal.length})
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {profiles.length === 0 ? (
          <div className="px-3 py-3 text-2xs text-muted-foreground">
            {t("connectionDialog.emptyList")}
          </div>
        ) : sections.length === 0 ? (
          <div className="px-3 py-3 text-2xs text-muted-foreground">
            {t("connectionDialog.noMatches")}
          </div>
        ) : (
          sections.map((section, i) => {
            const key = foldKey(i, section.originId);
            return (
              <ConnectionRailSection
                key={key}
                section={section}
                collapsed={!!foldedSections[key]}
                onToggleCollapsed={() =>
                  setFoldedSections((prev) => ({ ...prev, [key]: !prev[key] }))
                }
                groupCollapse={groupCollapse}
                searching={searching}
                active={active}
                editingId={editingId}
                checked={selection.checked}
                showOriginBadge={scope !== "shared"}
                originNameOf={originNameOf}
                onRowClick={onRowClick}
                onRowToggle={selection.toggle}
                onOpen={(id) => {
                  selection.clear();
                  onEdit(id);
                }}
                onToggleAll={selection.toggleAll}
              />
            );
          })
        )}
      </div>
      {checkedProfiles.length > 0 && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <span className="text-2xs text-muted-foreground">
            {t("connections.selectedCount", { count: checkedProfiles.length })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 gap-1 px-2 text-destructive hover:text-destructive"
            onClick={() => onDeleteRequest(checkedProfiles)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("connectionDialog.delete")}
          </Button>
        </div>
      )}
    </aside>
  );
}
