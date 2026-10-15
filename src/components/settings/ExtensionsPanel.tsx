/**
 * Colour themes from an Open VSX registry, docked beside the workspace.
 *
 * **A panel and not a dialog, which was the second attempt.** The first was a
 * dialog opened from Settings → Appearance, and it was wrong twice over:
 * picking variants after a download needs a dialog of its own, so installing
 * anything meant a dialog stacked on a dialog on a settings modal; and the
 * only way in was a small icon button in the theme list's header, which is
 * exactly the kind of affordance nobody finds. As a dock occupant it sits
 * beside the app the way VS Code's own does, the variant picker becomes the
 * only modal in the flow, and the entry point is a labelled button in the
 * activity bar.
 *
 * Three things here are decisions rather than layout:
 *
 * **The result count is approximate, and says so.** The registry's `Themes`
 * category covers icon themes, and its search response cannot say which hits
 * are colour themes — only each extension's manifest can, which the backend
 * fetches per candidate and filters on. A page of 24 hits routinely yields a
 * dozen rows, so an exact-looking figure would never match the list under it.
 *
 * **Installing reuses the variant picker rather than guessing.** An extension
 * contributes several themes and nothing says which light and dark variants
 * are counterparts, so a download hands off to `ImportVsCodeThemeDialog` — the
 * same dialog a local `.vsix` goes through. One path, one set of rules.
 *
 * **An update never silently rewrites a palette the user has edited.** The
 * backend tracks that per theme (`paletteEdited`, see ADR #88); this panel
 * turns it into two visibly different outcomes rather than one button that
 * quietly behaves differently.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { api } from "@/lib/tauri";
import { notify } from "@/lib/notify";
import { useThemeStore } from "@/stores/preferences/theme";
import { usePreferences } from "@/stores/preferences/preferences";
import {
  autoPairVariants,
  buildThemeImport,
  findInstalledFamily,
  VsCodeThemeError,
  type ThemeImportResult,
  type VsixPayload,
} from "@/lib/vscodeTheme";
import type {
  InstalledThemeSource,
  RegistryTheme,
  ThemeUpdate,
} from "@/lib/vscodeTheme/types";
import { ImportVsCodeThemeDialog } from "./dialogs/ImportVsCodeThemeDialog";

const PAGE_SIZE = 24;

interface Props {
  /** False while the dock is showing another occupant. The panel stays
   *  mounted (its search results and scroll position are worth keeping) but
   *  does not fetch — same contract as the Pulse panel. */
  active: boolean;
}

export function ExtensionsPanel({ active }: Props) {
  const { t } = useTranslation();
  const addImportedTheme = useThemeStore((s) => s.addImportedTheme);
  const applyThemeUpdate = useThemeStore((s) => s.applyThemeUpdate);
  const setThemeId = useThemeStore((s) => s.setThemeId);
  const activeThemeId = useThemeStore((s) => s.themeId);
  const installed = useThemeStore((s) => s.importedEditorThemes);
  const registryEnabled = usePreferences((s) => s.prefs.themes.registryEnabled);

  const [query, setQuery] = useState("");
  const [items, setItems] = useState<RegistryTheme[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [updates, setUpdates] = useState<ThemeUpdate[]>([]);

  /** The download awaiting a variant choice, plus where it came from. */
  const [pending, setPending] = useState<{
    payload: VsixPayload;
    theme: RegistryTheme;
    /** Present when this install is really an update of an existing family. */
    update?: ThemeUpdate;
  } | null>(null);

  // Guards against a slow search landing after a newer one. The registry is
  // occasionally slow, and out-of-order responses are how a list ends up
  // showing results for a query the user has already replaced.
  const requestSeq = useRef(0);
  const loadedOnce = useRef(false);

  const runSearch = useCallback(async (nextQuery: string, nextOffset: number) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.searchRegistryThemes(nextQuery, nextOffset, PAGE_SIZE);
      if (seq !== requestSeq.current) return;
      setItems(page.items);
      setTotal(page.total);
      setOffset(page.offset);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setItems([]);
      setError(String(e));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  // First activation only: an empty query is a valid search here and returns
  // the most-downloaded themes, which is a better opening state than a blank
  // panel. Re-running it every time the dock switches back would spend
  // someone else's bandwidth to show what is already on screen.
  useEffect(() => {
    if (!active || !registryEnabled || loadedOnce.current) return;
    loadedOnce.current = true;
    void runSearch("", 0);
    void api
      .checkThemeUpdates()
      .then((report) => setUpdates(report.updates))
      .catch(() => setUpdates([]));
  }, [active, registryEnabled, runSearch]);

  /**
   * Download an extension and install it.
   *
   * `chooseVariants` is what the picker used to be by default. Installing now
   * pairs the first light and first dark contribution itself
   * (`autoPairVariants`) and finishes, because for most extensions there is no
   * question to ask — the answer is "the light one and the dark one". The
   * picker stays reachable for the cases where the first is not what someone
   * wants, and is always used for an update, which must rebuild the exact
   * pairing that was installed rather than re-guess it.
   */
  async function beginInstall(
    theme: RegistryTheme,
    opts: { update?: ThemeUpdate; chooseVariants?: boolean } = {},
  ) {
    const { update, chooseVariants } = opts;
    setBusyId(`${theme.namespace}.${theme.name}`);
    try {
      const payload = await api.installRegistryTheme(theme);
      if (chooseVariants) {
        setPending({ payload, theme, update });
        return;
      }
      const selection = update
        ? {
            lightPath: update.theme.variants.find((v) => v.path === installedPath(update, "light"))
              ?.path,
            darkPath: update.theme.variants.find((v) => v.path === installedPath(update, "dark"))
              ?.path,
          }
        : autoPairVariants(payload.themes);
      // A recorded pairing can no longer exist (the extension dropped a
      // variant between versions), so fall back rather than refuse.
      const resolved =
        selection.lightPath || selection.darkPath
          ? selection
          : autoPairVariants(payload.themes);
      finishInstall(buildThemeImport(payload, resolved), { payload, theme, update });
    } catch (e) {
      notify.error(e instanceof VsCodeThemeError ? t(`settings.appearance.importError.${e.message}`) : String(e));
    } finally {
      setBusyId(null);
    }
  }

  /** The variant path recorded when this theme was installed, if any. */
  function installedPath(update: ThemeUpdate, side: "light" | "dark"): string | undefined {
    const record = installed[update.familyId]?.source;
    return (side === "light" ? record?.lightPath : record?.darkPath) ?? undefined;
  }

  function finishInstall(
    result: ThemeImportResult,
    context: { payload: VsixPayload; theme: RegistryTheme; update?: ThemeUpdate } | null = pending,
  ) {
    if (!context) return;
    const source: InstalledThemeSource = {
      // Recorded per theme so that pointing the app at a different registry
      // later cannot silently re-target this theme's updates.
      registryUrl: new URL(context.theme.downloadUrl).origin,
      namespace: context.theme.namespace,
      name: context.theme.name,
      version: context.theme.version,
      lightPath: result.selection.lightPath,
      darkPath: result.selection.darkPath,
    };
    const update = context.update;
    if (update) {
      applyThemeUpdate(
        { ...result, family: { ...result.family, id: update.familyId } },
        source,
        update.paletteEdited,
      );
      setUpdates((u) => u.filter((x) => x.familyId !== update.familyId));
      notify.success(
        t(
          update.paletteEdited
            ? "extensions.updatedEditorOnly"
            : "extensions.updated",
          { name: result.family.name },
        ),
      );
    } else {
      addImportedTheme(result, source);
      notify.success(t("settings.appearance.importSuccess", { name: result.family.name }));
    }
    setPending(null);
  }

  if (!registryEnabled) {
    return (
      <PanelFrame title={t("panels.extensions")}>
        <p className="p-3 text-xs text-muted-foreground">
          {t("extensions.disabled")}
        </p>
      </PanelFrame>
    );
  }

  return (
    <>
      <PanelFrame title={t("panels.extensions")}>
        <div className="flex h-full min-h-0 flex-col">
          <form
            className="flex gap-1.5 border-b border-border p-2"
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch(query, 0);
            }}
          >
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("extensions.searchPlaceholder")}
              className="h-7 flex-1 text-xs"
            />
            <Button type="submit" size="xs" disabled={loading}>
              <Search className="h-3 w-3" />
            </Button>
          </form>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {updates.length > 0 && (
              <div className="mb-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-2xs">
                <p className="mb-1 font-medium">
                  {t("extensions.updatesAvailable", { count: updates.length })}
                </p>
                <ul className="space-y-1">
                  {updates.map((u) => (
                    <li key={u.familyId} className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate">
                        {u.name} {u.installedVersion} → {u.availableVersion}
                      </span>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => void beginInstall(u.theme, { update: u })}
                      >
                        <RefreshCw className="h-3 w-3" />
                      </Button>
                    </li>
                  ))}
                </ul>
                {updates.some((u) => u.paletteEdited) && (
                  <p className="mt-1 text-muted-foreground">
                    {t("extensions.paletteEditedNote")}
                  </p>
                )}
              </div>
            )}

            {error && (
              <p className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-2xs text-destructive">
                {error}
              </p>
            )}

            {loading && items.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                {t("extensions.loading")}
              </p>
            ) : items.length === 0 && !error ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                {t("extensions.empty")}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {items.map((theme) => {
                  const familyId = findInstalledFamily(installed, theme);
                  return (
                    <ThemeRow
                      key={`${theme.namespace}.${theme.name}`}
                      theme={theme}
                      busy={busyId === `${theme.namespace}.${theme.name}`}
                      installedFamilyId={familyId}
                      isActive={familyId !== null && familyId === activeThemeId}
                      onInstall={() => void beginInstall(theme)}
                      onChooseVariants={() =>
                        void beginInstall(theme, { chooseVariants: true })
                      }
                      onApply={() => familyId && setThemeId(familyId)}
                    />
                  );
                })}
              </ul>
            )}
          </div>

          {items.length > 0 && (
            // Chevrons and a page counter, not two word buttons and a
            // sentence: at 340px the sentence truncated to "unos 1883
            // resulta…" and the buttons still overflowed. The `~` carries
            // what that sentence was for — the registry's total counts the
            // icon themes this list filters out, so the page count is an
            // upper bound.
            <div className="flex items-center justify-between gap-2 border-t border-border p-1.5">
              <Button
                size="xs"
                variant="ghost"
                aria-label={t("common.previous")}
                disabled={offset === 0 || loading}
                onClick={() => void runSearch(query, Math.max(0, offset - PAGE_SIZE))}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="truncate text-2xs tabular-nums text-muted-foreground">
                {t("extensions.page", {
                  page: Math.floor(offset / PAGE_SIZE) + 1,
                  pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
                })}
              </span>
              <Button
                size="xs"
                variant="ghost"
                aria-label={t("common.next")}
                disabled={offset + PAGE_SIZE >= total || loading}
                onClick={() => void runSearch(query, offset + PAGE_SIZE)}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
      </PanelFrame>

      {/* The same picker a local `.vsix` goes through — an extension is
          several themes either way, and the pairing rules must not differ by
          where the file came from. Now the only modal in the flow. */}
      <ImportVsCodeThemeDialog
        payload={pending?.payload ?? null}
        onCancel={() => setPending(null)}
        onConfirm={finishInstall}
      />
    </>
  );
}

function PanelFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2 text-3xs uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * Compact download counts, localised.
 *
 * `Intl` does this better than a hand-rolled K/M helper would: `maximum-
 * SignificantDigits: 3` gives `843K`, `1.45M`, `12.5K` in English and
 * `843 mil`, `1,45 M` in Spanish, with the locale's own separators. A raw
 * `842,877` is six characters of precision nobody acts on, in a column that
 * has to share one line with a rating and a variant count.
 */
function useCompactNumber() {
  const { i18n } = useTranslation();
  return useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        notation: "compact",
        maximumSignificantDigits: 3,
      }),
    [i18n.language],
  );
}

/**
 * A stable hue per extension, for the monogram shown when a theme publishes no
 * icon. Derived from the identifier so the same extension is always the same
 * colour — a random or fixed grey would make the fallback read as "broken
 * image" rather than as a deliberate placeholder. Fixed saturation and
 * lightness keep it legible against either app variant.
 */
function monogramHue(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

/**
 * The extension's published icon, falling back to a coloured monogram.
 *
 * `onError` matters more than it looks: the icon is a third-party URL on the
 * registry, and a 404 or a blocked request would otherwise leave a broken
 * image glyph in a list where every other row has artwork. The fixed box also
 * stops rows from reflowing as images arrive.
 */
function ThemeIcon({ theme }: { theme: RegistryTheme }) {
  const [failed, setFailed] = useState(false);
  const id = `${theme.namespace}.${theme.name}`;
  const showImage = theme.iconUrl && !failed;
  return (
    <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-md ring-1 ring-border/70">
      {showImage ? (
        <img
          src={theme.iconUrl ?? undefined}
          alt=""
          loading="lazy"
          className="h-full w-full bg-muted object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center text-sm font-semibold text-white"
          style={{ backgroundColor: `hsl(${monogramHue(id)} 45% 42%)` }}
        >
          {theme.displayName.trim().charAt(0).toUpperCase() || "?"}
        </div>
      )}
    </div>
  );
}

/**
 * One result card.
 *
 * The layout is a deliberate three-band split rather than a flat stack of
 * lines, because in a ~340px panel everything competes: **identity** (icon,
 * name, publisher) reads first, **description** second at full width where it
 * has room for two lines, and **metrics plus the action** share the last band.
 * The previous version put all six facts on consecutive equal-weight lines,
 * which scans as a paragraph rather than as a list of choices.
 *
 * Metrics are separated by middots rather than gaps: at this width the
 * separator costs less than the whitespace would, and it groups them as one
 * secondary unit against the button.
 */
function ThemeRow({
  theme,
  busy,
  installedFamilyId,
  isActive,
  onInstall,
  onChooseVariants,
  onApply,
}: {
  theme: RegistryTheme;
  busy: boolean;
  installedFamilyId: string | null;
  isActive: boolean;
  onInstall: () => void;
  onChooseVariants: () => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  const compact = useCompactNumber();
  const installed = installedFamilyId !== null;

  return (
    <li
      className={cn(
        "group rounded-lg border p-2.5 transition-colors duration-150",
        // An installed theme is marked by its border rather than by a badge
        // competing with the name; the active one gets the brand accent, which
        // is the app's own "this is live" colour.
        isActive
          ? "border-brand/60 bg-brand/[0.06]"
          : installed
            ? "border-success/40 hover:border-success/60"
            : "border-border hover:border-brand/40 hover:bg-accent/40",
      )}
    >
      <div className="flex gap-2.5">
        <ThemeIcon theme={theme} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-xs font-semibold leading-tight">
              {theme.displayName}
            </span>
            {isActive ? (
              <span className="shrink-0 rounded-sm bg-brand px-1 py-px text-3xs font-medium uppercase tracking-wide text-brand-foreground">
                {t("extensions.inUse")}
              </span>
            ) : (
              installed && <Check className="h-3 w-3 shrink-0 text-success" />
            )}
          </div>
          <p className="mt-0.5 truncate text-3xs text-muted-foreground">
            {theme.namespace}
            <span className="px-1 opacity-50">·</span>v{theme.version}
            {theme.license && (
              <>
                <span className="px-1 opacity-50">·</span>
                {theme.license}
              </>
            )}
          </p>
        </div>
      </div>

      {theme.description && (
        <p className="mt-1.5 line-clamp-2 text-2xs leading-relaxed text-muted-foreground">
          {theme.description}
        </p>
      )}

      <div className="mt-2 flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-3xs tabular-nums text-muted-foreground">
          <span className="inline-flex items-center gap-0.5">
            <Download className="h-2.5 w-2.5" />
            {compact.format(theme.downloadCount)}
          </span>
          {theme.averageRating != null && (
            <>
              <span className="px-1 opacity-50">·</span>
              <span className="inline-flex items-center gap-0.5">
                <Star className="h-2.5 w-2.5" />
                {theme.averageRating.toFixed(1)}
              </span>
            </>
          )}
          <span className="px-1 opacity-50">·</span>
          {t("extensions.variants", { count: theme.variants.length })}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {/* "Apply" only appears once a theme is installed and is not the
              active one — a button that does nothing visible is worse than no
              button. */}
          {installed && !isActive && (
            <Button size="xs" variant="outline" onClick={onApply}>
              {t("extensions.apply")}
            </Button>
          )}
          {/* Only offered when there is a choice to make. Installing takes the
              author's first light and dark variants without asking; this is
              for the person who wants Gruvbox Dark Hard rather than Medium. */}
          {theme.variants.length > 1 && (
            <IconButton
              size="xs"
              icon={SlidersHorizontal}
              label={t("extensions.chooseVariants")}
              disabled={busy}
              onClick={onChooseVariants}
            />
          )}
          <Button
            size="xs"
            variant={installed ? "ghost" : "default"}
            disabled={busy}
            onClick={onInstall}
          >
            {busy
              ? t("extensions.installing")
              : installed
                ? t("extensions.reinstall")
                : t("extensions.install")}
          </Button>
        </div>
      </div>
    </li>
  );
}
