/**
 * About panel — app version, tagline, repo link, the in-app update
 * controls, and the prefs-file paths on disk. The version is read at
 * mount time from the Tauri runtime (`getVersion`) so it always
 * matches the installed bundle, not a hardcoded string.
 *
 * The Updates card is its own component (`UpdatesCard`) — see
 * `./UpdatesCard.tsx`. This file stays focused on metadata.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateStore } from "@/stores/update";
import { useAppFlavor } from "@/stores/preferences/appFlavor";
import { getCurrentVersion } from "@/lib/appInfo/updater";
import { UpdatesCard } from "./UpdatesCard";
import { PatchNotesCard } from "./PatchNotesCard";
import { PrefGroup } from "./PrefGroup";

/** Build the per-OS prefs paths for a given state dir. The canary build lives
 *  under "HuginnDB-Canary", so hardcoding "HuginnDB" here would have shown the
 *  wrong (stable) location in the sandbox — another way the two looked alike. */
function prefsPaths(stateDir: string): { os: string; path: string }[] {
  return [
    { os: "Windows", path: `%APPDATA%\\${stateDir}\\prefs.json` },
    { os: "Linux", path: `$XDG_CONFIG_HOME/${stateDir}/prefs.json` },
    {
      os: "macOS",
      path: `~/Library/Application Support/${stateDir}/prefs.json`,
    },
  ];
}

/**
 * Resolve the running app version. Prefers whatever the update store
 * already cached (populated by the on-launch check) and falls back to a
 * direct `getVersion()` call only if the About panel is opened before
 * the launch check has resolved.
 */
function useResolvedVersion(): string {
  const storeCurrent = useUpdateStore((s) => s.currentVersion);
  const [fallback, setFallback] = useState<string | null>(null);

  useEffect(() => {
    if (storeCurrent) return;
    let cancelled = false;
    void getCurrentVersion()
      .then((v) => {
        if (!cancelled) setFallback(v);
      })
      .catch(() => {
        // Ignored: the About page just shows "—" if the version cannot
        // be resolved (e.g. when running outside the Tauri shell).
      });
    return () => {
      cancelled = true;
    };
  }, [storeCurrent]);

  return storeCurrent ?? fallback ?? "—";
}

export function AboutSection() {
  const { t } = useTranslation();
  const currentVersion = useResolvedVersion();
  const productName = useAppFlavor((s) => s.productName);
  const stateDir = useAppFlavor((s) => s.stateDir);
  const prefsLocations = prefsPaths(stateDir);

  return (
    <div className="space-y-5 text-sm">
      {/* About is one of the four surfaces the visual brief lets the brand
          speak fully (with launch, empty states and loading), so the identity
          card leads with the mark over a halftone wash instead of a text
          label. `productName` still renders underneath because the canary
          build shares this panel and must stay tellable apart. */}
      <div className="relative overflow-hidden rounded-lg border border-border bg-card/40 p-4">
        <span
          aria-hidden
          className="halftone pointer-events-none absolute inset-0 opacity-60"
        />
        <div className="relative flex items-start gap-3">
          <img
            src="/image/huginn-mark-256.png"
            alt=""
            width={256}
            height={256}
            className="h-12 w-12 shrink-0 select-none"
            draggable={false}
          />
          <div className="min-w-0">
            <div className="text-2xs uppercase tracking-wider text-muted-foreground">
              {productName}
            </div>
            <div className="mt-1 font-mono text-base">{currentVersion}</div>
            <div className="mt-2 text-xs text-muted-foreground">
              {t("settings.about.tagline")}
            </div>
            <div className="mt-2 text-xs">
              <a
                href="https://github.com/lopezz-dev/huginnDB"
                target="_blank"
                rel="noreferrer"
                className="text-brand hover:text-brand-hover hover:underline"
              >
                github.com/lopezz-dev/huginnDB
              </a>
            </div>
          </div>
        </div>
      </div>

      <UpdatesCard currentVersion={currentVersion} />

      <PatchNotesCard currentVersion={currentVersion} />

      <PrefGroup
        title={t("settings.about.prefsLocation")}
        description={t("settings.about.tabStateHint", { file: "tab_state.json" })}
      >
        <div className="divide-y divide-border/60">
          {prefsLocations.map((p) => (
            <div
              key={p.os}
              className="flex items-center justify-between gap-4 px-4 py-2.5"
            >
              <span className="text-xs">{p.os}</span>
              <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-2xs">
                {p.path}
              </code>
            </div>
          ))}
        </div>
      </PrefGroup>
    </div>
  );
}
