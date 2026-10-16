/**
 * The call to fetch `mongosh`, and everything that follows a click on it.
 *
 * One component for both places it is offered — the Terminal panel's empty
 * state and Settings → Terminal — so they cannot disagree about what a
 * download looks like. Idle (or after a failure) it is a button; while the
 * backend works it is a step label, a progress bar and a Cancel. The state
 * lives in `useMongoshDownload`, which is why closing Settings or switching the
 * dock to the Console does not read as cancelling.
 */

import { useTranslation } from "react-i18next";
import { Download, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { cn, formatBytes } from "@/lib/utils";
import { useMongoshDownload } from "@/stores/session/mongoshDownload";

interface MongoshDownloadProps {
  /** The idle button's text. Defaults to "Download mongosh". */
  label?: string;
  variant?: "default" | "outline";
  /** Where the content sits: centred in the empty state, at the start in a
   *  settings row. */
  align?: "center" | "start";
}

export function MongoshDownload({
  label,
  variant = "default",
  align = "center",
}: MongoshDownloadProps) {
  const { t } = useTranslation();
  const status = useMongoshDownload((s) => s.status);
  const start = useMongoshDownload((s) => s.start);
  const cancel = useMongoshDownload((s) => s.cancel);
  const dismiss = useMongoshDownload((s) => s.dismiss);

  if (status.phase === "running") {
    const percent =
      status.step === "downloading" && status.total
        ? Math.min(100, Math.round((status.received / status.total) * 100))
        : null;
    const stepText = status.cancelling
      ? t("terminal.download.cancelling")
      : status.attached
        ? t("terminal.download.elsewhere")
        : status.step === "downloading"
        ? t(status.total ? "terminal.download.downloading" : "terminal.download.downloadingUnknown", {
            version: status.version ?? "",
            received: formatBytes(status.received),
            total: status.total ? formatBytes(status.total) : "",
          })
        : t(`terminal.download.step.${status.step}`);
    return (
      <div
        className={cn(
          "flex w-full max-w-sm flex-col gap-1.5",
          align === "center" ? "items-center" : "items-start",
        )}
      >
        <div className="flex w-full items-center justify-between gap-2 text-xs text-muted-foreground">
          <span role="status" className="min-w-0 truncate">
            {stepText}
          </span>
          <Button
            size="xs"
            variant="quiet"
            icon={X}
            disabled={status.cancelling}
            onClick={cancel}
          >
            {t("terminal.download.cancel")}
          </Button>
        </div>
        <div
          role="progressbar"
          aria-label={t("terminal.download.progress")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={
              percent === null
                ? "h-full w-1/3 animate-pulse rounded-full bg-primary"
                : "h-full rounded-full bg-primary transition-[width]"
            }
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1.5", align === "center" ? "items-center" : "items-start")}>
      <Button size="sm" variant={variant} icon={Download} onClick={() => void start()}>
        {label ?? t("terminal.download.button")}
      </Button>
      {status.phase === "failed" && (
        <div className="flex max-w-sm items-start gap-1">
          <p role="alert" className="min-w-0 break-words text-xs text-destructive">
            {t("terminal.download.failed", { error: status.error })}
          </p>
          <IconButton
            size="xs"
            flat
            icon={X}
            label={t("terminal.download.dismiss")}
            side="top"
            onClick={dismiss}
          />
        </div>
      )}
    </div>
  );
}
