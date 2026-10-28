/**
 * The connection picker inside Settings → MCP, as a tree.
 *
 * Deliberately the connection rail's shape with less in it. It shares the rail's
 * layout decision — provenance is the outer axis, the free-text `group` folder
 * the inner one, both via `buildRailSections` — so the same server appears in the
 * same place in both surfaces and the labels cannot drift. What it drops is
 * everything the rail needs and this doesn't: no live-pool dot (nothing is
 * connected from here), no driver badge or host subline (the snippet is built
 * from ids, not endpoints), no keyboard range selection. A row is a checkbox, a
 * name, and the two controls that matter here — its write policy and how many
 * rows one MCP call may return from it.
 *
 * Group folds reuse `useConnectionGroupCollapse`, so a folder the user collapsed
 * in the manager opens collapsed here too; section folds are local state, for the
 * same reason they are in the rail (provenance is a new axis and does not belong
 * to a preference about connection *groups*).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Folder, FolderSync } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { FoldRow } from "@/components/ui/fold-row";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { isFromOrigin } from "@/lib/connection/origin";
import type { RailSection } from "@/lib/connection/railSections";
import { useConnectionGroupCollapse } from "@/lib/connection/useConnectionGroups";
import type { ConnectionProfile, McpWritePolicy } from "@/types";

import { McpMaxRowsInput } from "./McpMaxRowsInput";
import { McpWritePolicySelect } from "./McpWritePolicySelect";

export function McpConnectionTree({
  sections,
  selected,
  onToggle,
  onToggleAll,
  onSetPolicy,
  onSetMaxRows,
  defaultMaxRows,
  sharedTooltip,
  searching,
}: {
  sections: RailSection[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[]) => void;
  onSetPolicy: (id: string, level: McpWritePolicy) => void;
  /** `null` clears the connection's own limit, back to `defaultMaxRows`. */
  onSetMaxRows: (id: string, rows: number | null) => void;
  /** The global `connections.mcpMaxRows`, each row's placeholder. */
  defaultMaxRows: number;
  sharedTooltip: (profile: ConnectionProfile) => string;
  /** An active search force-expands groups so a match is never hidden. */
  searching: boolean;
}) {
  const { t } = useTranslation();
  const groupCollapse = useConnectionGroupCollapse();
  const [foldedSections, setFoldedSections] = useState<Record<string, boolean>>(
    {},
  );

  function row(p: ConnectionProfile) {
    return (
      <div
        key={p.id}
        className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent"
      >
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
          <Checkbox
            checked={selected.has(p.id)}
            onChange={() => onToggle(p.id)}
          />
          <span className="truncate text-xs">{p.name}</span>
          {isFromOrigin(p) && (
            <SimpleTooltip label={sharedTooltip(p)}>
              <span className="flex shrink-0 items-center">
                <FolderSync className="h-3 w-3 text-muted-foreground" />
              </span>
            </SimpleTooltip>
          )}
        </label>
        <McpMaxRowsInput
          name={p.name}
          value={p.mcp_max_rows}
          fallback={defaultMaxRows}
          onChange={(rows) => onSetMaxRows(p.id, rows)}
        />
        <McpWritePolicySelect
          value={p.mcp_write}
          onChange={(level) => onSetPolicy(p.id, level)}
        />
      </div>
    );
  }

  return (
    <>
      {sections.map((section, i) => {
        // `originId` is null both for a headerless section and for the orphaned
        // one, so the index is the tie-break.
        const key = section.originId ?? `section:${i}`;
        const collapsed = !!foldedSections[key];
        const allIn =
          section.ids.length > 0 && section.ids.every((id) => selected.has(id));
        return (
          <div key={key}>
            <div className="flex items-center gap-1.5 border-y border-border/60 bg-muted/30 px-3 py-1 first:border-t-0">
              <Checkbox
                size="xs"
                checked={allIn}
                onChange={() => onToggleAll(section.ids)}
                onClick={(e) => e.stopPropagation()}
                aria-label={t("settings.mcp.selectAllInSection", {
                  section: section.label,
                })}
              />
              <FoldRow
                open={!collapsed}
                label={section.label}
                count={section.ids.length}
                onClick={() =>
                  setFoldedSections((prev) => ({ ...prev, [key]: !prev[key] }))
                }
              />
            </div>
            {!collapsed && (
              <>
                {section.ungrouped.map(row)}
                {section.groups.map(({ name, items }) => {
                  const groupCollapsed =
                    !searching && groupCollapse.isCollapsed(name);
                  return (
                    <div key={name}>
                      <div className="flex items-center gap-1.5 px-3 py-1">
                        <Checkbox
                          size="xs"
                          checked={items.every((p) => selected.has(p.id))}
                          onChange={() => onToggleAll(items.map((p) => p.id))}
                          aria-label={t("settings.mcp.selectAllInSection", {
                            section: name,
                          })}
                        />
                        <FoldRow
                          level="group"
                          open={!groupCollapsed}
                          icon={Folder}
                          label={name}
                          count={items.length}
                          onClick={() => groupCollapse.toggle(name)}
                        />
                      </div>
                      {!groupCollapsed && items.map(row)}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        );
      })}
    </>
  );
}
