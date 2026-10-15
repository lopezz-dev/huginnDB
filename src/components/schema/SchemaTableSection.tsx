/**
 * The "tables" / "views" header inside a schema node — the header only.
 *
 * `TableSection` used to render the header *and* every `TableRow` under it,
 * which is exactly where a ten-thousand-table SQL Server schema froze the
 * panel: opening the section mounted all of them at once. The tree is one
 * virtualised list now (ADR #108) and the rows under this header are rows of
 * their own.
 */

import { memo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Eye, Table as TableIcon } from "lucide-react";

import { TreeRow } from "@/components/ui/tree-row";
import { useSchema } from "@/stores/session/schema";

export const TableSectionHeader = memo(function TableSectionHeader({
  connectionId,
  section,
  sectionKey,
  count,
  open,
}: {
  connectionId: string;
  section: "tables" | "views";
  sectionKey: string;
  count: number;
  open: boolean;
}) {
  const { t } = useTranslation();
  const Icon = section === "tables" ? TableIcon : Eye;
  return (
    <TreeRow
      className="py-1 pl-5"
      aria-expanded={open}
      onClick={() => useSchema.getState().toggleNode(connectionId, sectionKey)}
    >
      {open ? (
        <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
      ) : (
        <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
      )}
      <Icon className="h-3 w-3 text-muted-foreground/70" />
      <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {t(section === "tables" ? "schema.sectionTables" : "schema.sectionViews")}
      </span>
      <span className="ml-auto text-3xs tabular-nums text-muted-foreground/60">
        {count}
      </span>
    </TreeRow>
  );
});
