/**
 * The bodies of a statement tab that has no rows to show (ADR #137): what a
 * write did, and why a statement failed. Each says which statement it is,
 * shows the statement, and can select it in the editor.
 *
 * The error card is deliberately plain: the driver's message, the statement,
 * *Go to statement* and *Copy error*. No AI action — decided with the ADR, so
 * a failure reads as the database's answer and not as a prompt.
 */

import { useTranslation } from "react-i18next";
import { Check, Copy, CornerDownRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { notify } from "@/lib/notify";
import type { ErrorTab, LineRange, WriteTab } from "@/lib/query/statementTabs";

interface CardProps<T> {
  tab: T;
  /** Select the statement's lines in the editor. */
  onGoTo: (lines: LineRange) => void;
}

function GoTo({ lines, onGoTo }: { lines: LineRange | null; onGoTo: (l: LineRange) => void }) {
  const { t } = useTranslation();
  if (!lines) return null;
  return (
    <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-2xs" onClick={() => onGoTo(lines)}>
      <CornerDownRight className="h-3 w-3" />
      {t("query.goToStatement")}
    </Button>
  );
}

function Statement({ sql }: { sql: string }) {
  return (
    <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-sm bg-muted/50 px-2 py-1 font-mono text-2xs text-muted-foreground">
      {sql}
    </pre>
  );
}

export function WriteCard({ tab, onGoTo }: CardProps<WriteTab>) {
  const { t } = useTranslation();
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <div className="flex items-center gap-2 text-xs">
        <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span>
          {t("query.rowsAffected", { rows: tab.rowsAffected, ms: tab.elapsedMs })}
        </span>
        <span className="ml-auto">
          <GoTo lines={tab.lines} onGoTo={onGoTo} />
        </span>
      </div>
      <div className="mt-2">
        <Statement sql={tab.sql} />
      </div>
    </div>
  );
}

export function ErrorCard({ tab, onGoTo }: CardProps<ErrorTab>) {
  const { t } = useTranslation();
  const copy = () =>
    void copyToClipboard(tab.message).then(
      () => notify.success(t("query.errorCopied")),
      () => {},
    );
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <div className="flex items-center gap-2 text-xs text-destructive">
        <X className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">
          {tab.statement === null
            ? t("query.runFailed")
            : t("query.statementFailed", { index: tab.statement })}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <GoTo lines={tab.lines} onGoTo={onGoTo} />
          <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-2xs" onClick={copy}>
            <Copy className="h-3 w-3" />
            {t("query.copyError")}
          </Button>
        </span>
      </div>
      <div className="mt-2 whitespace-pre-wrap rounded-sm bg-destructive/10 px-2 py-1.5 font-mono text-xs text-destructive">
        {tab.message}
      </div>
      <div className="mt-2">
        <Statement sql={tab.sql} />
      </div>
    </div>
  );
}
