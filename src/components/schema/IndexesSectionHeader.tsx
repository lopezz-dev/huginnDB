/**
 * Collapsible "indexes" header within a schema node. Headers only for now — the
 * index list itself lives in the structure editor and, for MongoDB, in the
 * dedicated index manager.
 */

import { ChevronDown, ChevronRight, LayoutList } from "lucide-react";
import { useTranslation } from "react-i18next";

import { TreeRow } from "@/components/ui/tree-row";
import { useSchema } from "@/stores/session/schema";

export function IndexesSectionHeader({
  sectionKey,
  connectionId,
  open,
}: {
  sectionKey: string;
  connectionId: string;
  open: boolean;
}) {
  const { t } = useTranslation();
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
      <LayoutList className="h-3 w-3 text-muted-foreground/70" />
      <span className="text-2xs text-muted-foreground">
        {t("schema.sectionIndexes")}
      </span>
    </TreeRow>
  );
}
