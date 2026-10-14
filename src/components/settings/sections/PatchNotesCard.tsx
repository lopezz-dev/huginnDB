/**
 * "What's new" card inside the About panel. Reads the bundled changelog
 * (`src/lib/changelog.ts`) for the active UI language, lets the user pick a
 * version, and renders that release's notes. Defaults to the installed version
 * when it appears in the list.
 *
 * Notes content is plain text from the changelog with inline `**bold**` markup;
 * `renderInline` turns that into <strong> runs without pulling in a Markdown
 * renderer.
 */

import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MICRO_HEADING } from "@/components/ui/styles";
import { PrefGroup } from "./PrefGroup";
import { cn } from "@/lib/utils";
import { usePreferences } from "@/stores/preferences/preferences";
import { getReleases } from "@/lib/appInfo/changelog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Split a string on `**bold**` spans into React nodes. */
function renderInline(text: string): React.ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return parts.map((part, i) =>
    // Odd indices are the captured bold runs.
    i % 2 === 1 ? (
      <strong key={i} className="font-semibold text-foreground">
        {part}
      </strong>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

interface Props {
  /** Resolved current app version (e.g. "1.0.2"), or "—" when unknown. */
  currentVersion: string;
}

export function PatchNotesCard({ currentVersion }: Props) {
  const { t } = useTranslation();
  const language = usePreferences((s) => s.prefs.ui.language);

  // Re-parse only when the language changes (the parser caches internally).
  const releases = useMemo(() => getReleases(language), [language]);

  // Default to the installed version if present, else the first entry
  // (Unreleased, or the latest release).
  const defaultVersion = useMemo(() => {
    const match = releases.find((r) => r.version === currentVersion);
    return match?.version ?? releases[0]?.version ?? "";
  }, [releases, currentVersion]);

  const [selected, setSelected] = useState<string | null>(null);
  const activeVersion = selected ?? defaultVersion;
  const release = releases.find((r) => r.version === activeVersion);

  if (releases.length === 0) return null;

  return (
    <PrefGroup
      title={t("settings.about.patchNotes")}
      action={
        <Select value={activeVersion} onValueChange={(v) => setSelected(v)}>
          <SelectTrigger className="h-7 w-40 text-xs">
            <SelectValue aria-label={activeVersion}>
              {activeVersion === "Unreleased"
                ? t("settings.about.patchNotesUnreleased")
                : activeVersion}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {releases.map((r) => (
              <SelectItem key={r.version} value={r.version} className="text-xs">
                {r.version === "Unreleased"
                  ? t("settings.about.patchNotesUnreleased")
                  : r.version}
                {r.version === currentVersion
                  ? ` · ${t("settings.about.patchNotesCurrent")}`
                  : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
      padded
    >
      <div className="max-h-72 space-y-3 overflow-y-auto pr-1 text-xs leading-relaxed">
        {!release || (release.sections.length === 0 && !release.intro) ? (
          <div className="text-muted-foreground">
            {t("settings.about.patchNotesNone")}
          </div>
        ) : (
          <>
            {release.date && (
              <div className="font-mono text-3xs text-muted-foreground">
                {release.date}
              </div>
            )}
            {release.intro && (
              <p className="text-muted-foreground">
                {renderInline(release.intro)}
              </p>
            )}
            {release.sections.map((s) => (
              <div key={s.heading}>
                <div className={cn(MICRO_HEADING, "mb-1 text-brand")}>
                  {s.heading}
                </div>
                <ul className="space-y-1">
                  {s.items.map((it, i) => (
                    <li key={i} className="flex gap-1.5 text-muted-foreground">
                      <span className="select-none text-brand">·</span>
                      <span>{renderInline(it)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="text-2xs">
        <a
          href="https://github.com/lopezz-dev/huginnDB/blob/main/CHANGELOG.md"
          target="_blank"
          rel="noreferrer"
          className="text-brand hover:underline"
        >
          {t("settings.about.patchNotesViewOnGitHub")}
        </a>
      </div>
    </PrefGroup>
  );
}
