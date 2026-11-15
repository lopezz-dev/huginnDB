import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import type { QueryResult } from "@/types";

/**
 * Feedback for a single DML statement (INSERT/UPDATE/DELETE) run outside a
 * batch. `DataGrid` has nothing to show for a columns-less result, so
 * without this the results panel just looked empty after Ctrl+Enter.
 */
export function DmlResult({ result }: { result: QueryResult }) {
  const { t } = useTranslation();
  return (
    <div className="shrink-0 border-b border-border bg-card/40">
      <div className="flex items-center gap-2 px-3 py-1 text-2xs text-muted-foreground">
        <Check className="h-3 w-3 shrink-0 text-primary" />
        <span>
          {t("query.rowsAffected", {
            rows: result.rows_affected,
            ms: result.elapsed_ms,
          })}
        </span>
      </div>
    </div>
  );
}
