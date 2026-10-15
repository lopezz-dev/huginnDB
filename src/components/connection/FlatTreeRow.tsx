/**
 * One row of the schema tree's flat list, by kind (ADR #108).
 *
 * `buildFlatTree` decides *what* the rows are; this decides what each one
 * looks like, and draws the tree guides the nested containers used to draw.
 * Those were a `ml-3 border-l pl-0.5` wrapper around every subtree (a folder's
 * connections, a connection's schema, a database's tables); here each row is
 * wrapped in as many of them as it had ancestors, so the geometry is identical
 * and adjacent rows' borders meet into the same continuous hairline.
 */

import { memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { VanishedOriginNotice } from "@/components/common/VanishedOriginNotice";
import { GroupHeader } from "@/components/connection/GroupHeader";
import { DatabaseRow, NoDatabasesRow } from "@/components/schema/DatabaseRow";
import { IndexesSectionHeader } from "@/components/schema/IndexesSectionHeader";
import { BoundDatabaseRow, SchemaHeaderRow } from "@/components/schema/SchemaNodeRows";
import { TableSectionHeader } from "@/components/schema/SchemaTableSection";
import {
  ColumnRow,
  ColumnsErrorRow,
  ColumnsLoadingRow,
  TableRow,
} from "@/components/schema/SchemaTableRow";
import { SchemaLoadError, TreeSkeleton } from "@/components/schema/TreeStatus";
import { tableActionsFor } from "@/lib/schema/tableActions";
import { tableTabKey, type OpenTableKeys } from "@/lib/schema/useOpenTableKeys";
import type { FlatRow, RetryTarget } from "@/lib/schema/flatTree";
import { useDatabaseViews } from "@/stores/session/databaseViews";
import { useSchema } from "@/stores/session/schema";
import type { ConnectionProfile, SchemaTableMetric } from "@/types";

function Guides({ count, children }: { count: number; children: ReactNode }) {
  let node = children;
  for (let i = 0; i < count; i += 1) {
    node = <div className="ml-3 border-l border-border/35 pl-0.5">{node}</div>;
  }
  return <>{node}</>;
}

function retry(target: RetryTarget) {
  if (target.kind === "refresh") {
    void useSchema.getState().refresh(target.connectionId);
  } else {
    // Forgetting the failure is the retry: the tree's needs effect sees an
    // expanded database with no view and opens it again.
    useDatabaseViews.getState().clearError(target.childId);
  }
}

export interface FlatTreeRowProps {
  row: FlatRow;
  renderConnection: (profile: ConnectionProfile) => ReactNode;
  onToggleGroup: (name: string) => void;
  metric: SchemaTableMetric;
  openKeys: OpenTableKeys;
}

export const FlatTreeRow = memo(function FlatTreeRow({
  row,
  renderConnection,
  onToggleGroup,
  metric,
  openKeys,
}: FlatTreeRowProps) {
  const { t } = useTranslation();
  const isTableActive = (connectionId: string, schema: string, table: string) =>
    openKeys.activeTableKey === tableTabKey(connectionId, schema, table);

  let body: ReactNode;
  switch (row.kind) {
    case "all-hidden":
      body = (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          {t("connectionsTree.selectConnections.allHidden")}
        </div>
      );
      break;
    case "group":
      body = (
        <GroupHeader
          name={row.name}
          count={row.count}
          collapsed={row.collapsed}
          onToggle={onToggleGroup}
        />
      );
      break;
    case "connection":
      body = renderConnection(row.profile);
      break;
    case "origin-notice":
      body = <VanishedOriginNotice profileId={row.profileId} />;
      break;
    case "skeleton":
      body =
        row.variant === "columns" && row.tableTabKey ? (
          <ColumnsLoadingRow
            isActive={isTableActive(
              row.tableTabKey.connectionId,
              row.tableTabKey.schema,
              row.tableTabKey.table,
            )}
          />
        ) : (
          <TreeSkeleton
            label={t("schema.loading")}
            rows={row.rows}
            className="space-y-1.5 px-3 py-2"
          />
        );
      break;
    case "load-error":
      body = (
        <SchemaLoadError message={row.message} onRetry={() => retry(row.retry)} />
      );
      break;
    case "subset-note":
      body = (
        <div className="px-3 pb-2 text-2xs text-muted-foreground">
          {t(
            row.local
              ? "schema.selectDatabases.subsetActiveLocal"
              : "schema.selectDatabases.subsetActive",
            { count: row.count, total: row.total },
          )}
        </div>
      );
      break;
    case "no-matches":
      body = (
        <div className="px-3 py-2 text-xs italic text-muted-foreground">
          {t("schema.noMatches")}
        </div>
      );
      break;
    case "no-databases":
      body = <NoDatabasesRow row={row} />;
      break;
    case "database":
      body = <DatabaseRow row={row} />;
      break;
    case "bound-database":
      body = <BoundDatabaseRow row={row} />;
      break;
    case "schema":
      body = <SchemaHeaderRow row={row} />;
      break;
    case "section":
      body = (
        <TableSectionHeader
          connectionId={row.connectionId}
          section={row.section}
          sectionKey={row.sectionKey}
          count={row.count}
          open={row.open}
        />
      );
      break;
    case "table": {
      const key = tableTabKey(row.connectionId, row.table.schema, row.table.name);
      body = (
        <TableRow
          table={row.table}
          connectionId={row.connectionId}
          expanded={row.expanded}
          hasColumns={row.hasColumns}
          hasColumnError={row.hasColumnError}
          actions={tableActionsFor(row.connectionId, row.driver)}
          metric={metric}
          isActive={openKeys.activeTableKey === key}
          isOpen={openKeys.openTableKeys.has(key)}
        />
      );
      break;
    }
    case "column":
      body = (
        <ColumnRow
          column={row.column}
          isActive={isTableActive(row.connectionId, row.schema, row.table)}
        />
      );
      break;
    case "columns-error":
      body = (
        <ColumnsErrorRow
          connectionId={row.connectionId}
          schema={row.schema}
          table={row.table}
          message={row.message}
          isActive={isTableActive(row.connectionId, row.schema, row.table)}
        />
      );
      break;
    case "indexes":
      body = (
        <IndexesSectionHeader
          connectionId={row.connectionId}
          sectionKey={row.sectionKey}
          open={row.open}
        />
      );
      break;
  }

  // Everything under a connection inherits the `text-sm` its explorer's
  // wrapper used to set; the folder and connection rows set their own, and the
  // origin notice sat above that wrapper.
  const inSubtree =
    row.kind !== "all-hidden" &&
    row.kind !== "group" &&
    row.kind !== "connection" &&
    row.kind !== "origin-notice";
  return (
    <Guides count={row.guides}>
      {inSubtree ? <div className="text-sm">{body}</div> : body}
    </Guides>
  );
});
