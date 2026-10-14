/**
 * Updates panel rendered inside `AboutSection`.
 *
 * Self-contained: subscribes to whatever the global update store reports
 * and owns the manual "Check now" / "Install and relaunch" interactions.
 * Kept out of AboutSection.tsx so each file stays focused — one file for
 * app metadata, one file for the update lifecycle.
 *
 * The card has four mutually exclusive visual states, derived from the
 * store's `status` field:
 *
 *   • "available"   — shows release notes + install button + progress.
 *   • "downloading" — same as available, but the install button is
 *                     disabled and the progress bar animates.
 *   • "installing"  — same as available, but the install button shows a
 *                     spinner + "Restarting…" and is disabled. Covers
 *                     both the async gap between the click and the real
 *                     install() call, and the brief `ready` status right
 *                     before the relaunch (see stores/update.ts) — so the
 *                     button never silently reverts to its idle label.
 *   • "error"       — error line in place of the up-to-date message.
 *   • everything else (idle / checking) — "you're on the latest"
 *                     reassurance line.
 *
 * Below it, the silent updater (`src-tauri/src/updater/`): the switch that
 * registers or removes its scheduled tasks, and one line saying which layer is
 * actually in force on this machine — or why none is — so support can tell at
 * a glance why a workstation is not updating.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, RefreshCw } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/tauri";
import { formatDateTime } from "@/lib/utils";
import { usePreferences } from "@/stores/preferences/preferences";
import { useUpdateStore } from "@/stores/update";
import type { AutoUpdateStatus } from "@/types";
import { PrefGroup } from "./PrefGroup";
import { PrefRow } from "./PrefRow";

interface Props {
  /** Resolved current version. Passed in so the parent owns the fallback path. */
  currentVersion: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdatesCard({ currentVersion }: Props) {
  const { t } = useTranslation();
  const status = useUpdateStore((s) => s.status);
  const availableVersion = useUpdateStore((s) => s.availableVersion);
  const releaseNotes = useUpdateStore((s) => s.releaseNotes);
  const downloadProgress = useUpdateStore((s) => s.downloadProgress);
  const error = useUpdateStore((s) => s.error);
  const checkManually = useUpdateStore((s) => s.checkManually);
  const installAndRelaunch = useUpdateStore((s) => s.installAndRelaunch);

  const isChecking = status === "checking";
  const isDownloading = status === "downloading";
  const isReadyToRestart = status === "readyToRestart";
  const isInstalling = status === "installing" || status === "ready";
  const hasUpdate =
    (status === "available" ||
      isDownloading ||
      isReadyToRestart ||
      isInstalling) &&
    availableVersion !== null;
  const hasError = status === "error" && error !== null;
  // Only show the up-to-date reassurance when we're truly settled — not
  // mid-check, mid-download, mid-install, or while bubbling an error.
  const showUpToDate =
    !hasUpdate && !hasError && !isChecking && !isDownloading && !isInstalling;

  const progressPct =
    downloadProgress && downloadProgress.total
      ? Math.min(
          100,
          Math.round(
            (downloadProgress.downloaded / downloadProgress.total) * 100,
          ),
        )
      : null;

  return (
    <>
      <PrefGroup
        title={t("update.sectionTitle")}
        action={
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              void checkManually();
            }}
            disabled={isChecking || isDownloading || isInstalling}
          >
            {isChecking ? (
              <Spinner size="xs" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            {t("update.checkNow")}
          </Button>
        }
        padded
      >
        {!hasUpdate && !showUpToDate && !hasError && (
          <div className="text-xs text-muted-foreground">
            {t("update.checkPrompt")}
          </div>
        )}

        {hasUpdate && (
          <div className="space-y-2">
            <div className="text-xs">
              {t("update.availableLine", {
                current: currentVersion,
                next: availableVersion,
              })}
            </div>
            {releaseNotes && (
              <details className="text-2xs text-muted-foreground">
                <summary className="cursor-pointer hover:text-foreground">
                  {t("update.releaseNotes")}
                </summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-muted/40 p-2 font-mono text-3xs">
                  {releaseNotes}
                </pre>
              </details>
            )}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => {
                  void installAndRelaunch();
                }}
                disabled={isDownloading || isInstalling}
              >
                {isDownloading || isInstalling ? (
                  <Spinner size="xs" />
                ) : (
                  <Download className="h-3 w-3" />
                )}
                {isDownloading
                  ? t("update.downloading")
                  : isInstalling
                    ? t("update.restarting")
                    : isReadyToRestart
                      ? t("update.restartNow")
                      : t("update.installAndRelaunch")}
              </Button>
              <a
                href="https://github.com/lopezz-dev/huginnDB/releases"
                target="_blank"
                rel="noreferrer"
                className="text-2xs text-muted-foreground hover:text-brand hover:underline"
              >
                {t("update.openReleases")}
              </a>
            </div>
            {isDownloading && downloadProgress && (
              <div className="mt-1 space-y-1">
                <div className="h-1 w-full overflow-hidden rounded-sm bg-muted">
                  <div
                    className="h-full bg-brand transition-[width]"
                    style={{ width: `${progressPct ?? 0}%` }}
                  />
                </div>
                <div className="text-3xs text-muted-foreground">
                  {formatBytes(downloadProgress.downloaded)}
                  {downloadProgress.total
                    ? ` / ${formatBytes(downloadProgress.total)}`
                    : ""}
                </div>
              </div>
            )}
          </div>
        )}

        {showUpToDate && (
          <div className="text-xs text-muted-foreground">
            {t("update.upToDate", { version: currentVersion })}
          </div>
        )}

        {hasError && (
          <div className="text-xs text-destructive">
            {t("update.errorPrefix")} {error}
          </div>
        )}
      </PrefGroup>
      <BackgroundUpdates />
    </>
  );
}

/** How long the backend's reconcile (it shells out to `schtasks`) is given
 *  before the status is read back after the switch moves. */
const RECONCILE_SETTLE_MS = 1500;

function BackgroundUpdates() {
  const { t } = useTranslation();
  const autoInstall = usePreferences((s) => s.prefs.updates.autoInstall);
  const updateUpdates = usePreferences((s) => s.updateUpdates);
  const [status, setStatus] = useState<AutoUpdateStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const read = () =>
      api
        .getAutoUpdateStatus()
        .then((s) => alive && setStatus(s))
        .catch(() => alive && setStatus(null));
    void read();
    // The preference save is debounced and the reconcile runs after it, so a
    // second read picks up what the switch actually did.
    const timer = window.setTimeout(read, RECONCILE_SETTLE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [autoInstall]);

  return (
    <PrefGroup title={t("update.background.title")}>
      <PrefRow
        label={t("update.autoInstall.label")}
        description={t("update.autoInstall.desc")}
        prefId="updates.autoInstall"
      >
        <Switch
          checked={autoInstall}
          onCheckedChange={(v) => updateUpdates({ autoInstall: v })}
        />
      </PrefRow>
      {status && (
        <div className="space-y-0.5 px-4 py-2.5 text-2xs leading-snug text-muted-foreground">
          <div>{scheduleLine(status, autoInstall, t)}</div>
          {status.lastRun && <div>{lastRunLine(status.lastRun, t)}</div>}
        </div>
      )}
    </PrefGroup>
  );
}

type T = ReturnType<typeof useTranslation>["t"];

/** Which layer launches the updater, or why none does. */
function scheduleLine(
  status: AutoUpdateStatus,
  autoInstall: boolean,
  t: T,
): string {
  if (!status.supported) return t("update.background.unsupported");
  if (!autoInstall) return t("update.background.mechanism.disabled");
  const schedule = status.schedule;
  if (!schedule) return t("update.background.pending");
  const line = t(`update.background.mechanism.${schedule.mechanism}`);
  return schedule.detail && schedule.mechanism !== "tasks"
    ? `${line} ${t("update.background.windowsSaid", {
        detail: schedule.detail,
      })}`
    : line;
}

function lastRunLine(
  run: NonNullable<AutoUpdateStatus["lastRun"]>,
  t: T,
): string {
  const at = formatDateTime(run.atMs);
  const o = run.outcome;
  switch (o.kind) {
    case "deferred":
      return t(`update.background.run.deferred.${o.reason}`, {
        at,
        version: o.version,
      });
    case "installing":
      return t("update.background.run.installing", { at, version: o.version });
    case "failed":
      return t("update.background.run.failed", { at, message: o.message });
    default:
      return t(`update.background.run.${o.kind}`, { at });
  }
}
