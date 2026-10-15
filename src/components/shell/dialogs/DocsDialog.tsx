/**
 * Documentation viewer — Help → Documentation.
 *
 * A workbench dialog built on the same anatomy as Preferences (convention #82), so
 * the two read as one family: a header, a left rail with its own search box and
 * grouped entries, and a pane with a page header above a scrolling body.
 *
 * - **Home.** The viewer opens on a grid of every guide with what it is for,
 *   rather than inside whichever guide happened to be first.
 * - **A guide opens on its cover** (the prose before its first `##`, plus a card
 *   per section); picking a section shows that section alone. Paging rather than
 *   one long scroll because `docs/MCP.md` is 600+ lines, and finding what a tool
 *   requires meant scrolling blind past five client configurations.
 * - **Search** (`lib/appInfo/docSearch`) replaces the page with the passages that
 *   match every word, each opening the page and the heading it sits under.
 * - **Reading aids**: an "On this page" column that follows the scroll
 *   (`xl` and up; below it the rail carries those headings), and previous / next
 *   at the foot of every page.
 * - **Back to Preferences**: a guide that is also a Preferences section offers to
 *   open it, the mirror of the "read the guide" button Preferences shows
 *   (`lib/appInfo/settingsDocs`).
 *
 * The page's own `#`/`##` heading is dropped from the body: the page header above
 * it already says it, and rendering both put the same words on screen twice.
 * Anchors to that heading still resolve — `locate` finds the section by slug, not
 * by the heading being drawn.
 *
 * The rail is derived from the markdown itself (`lib/appInfo/docOutline`), not
 * from a hand-maintained list — which is also what translates it for free: the
 * Spanish body carries Spanish headings, so `getDocBody` picking the language
 * picks the rail's labels too. Adding a section to a doc adds it here with no
 * code change.
 *
 * Controlled by `useDocsDialog`.
 */

import * as React from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, ExternalLink, FileText, Settings2 } from "lucide-react";
import { DOCS, getDoc, getDocBody, type DocEntry } from "@/lib/appInfo/docs";
import { locate, parseDoc, type ParsedDoc } from "@/lib/appInfo/docOutline";
import { searchDocs, type DocHit } from "@/lib/appInfo/docSearch";
import { settingsSectionForDoc } from "@/lib/appInfo/settingsDocs";
import { useDocsDialog } from "@/stores/dialogs/docsDialog";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { Markdown, type DocNavigator } from "@/components/shell/Markdown";
import { DocsRail } from "@/components/shell/docs/DocsRail";
import { DocsHome } from "@/components/shell/docs/DocsHome";
import { DocsSearchResults } from "@/components/shell/docs/DocsSearchResults";
import { DocsPageHeader } from "@/components/shell/docs/DocsPageHeader";
import { DocsPager, type PagerTarget } from "@/components/shell/docs/DocsPager";
import { DocsToc } from "@/components/shell/docs/DocsToc";
import { docIcon } from "@/components/shell/docs/docIcons";
import { formatDocDate } from "@/components/shell/docs/formatDocDate";
import { useScrollSpy } from "@/components/shell/docs/useScrollSpy";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { TreeRow } from "@/components/ui/tree-row";
import { CONTROL_FOCUS_TIGHT } from "@/components/ui/styles";
import { useShortcutLabel } from "@/lib/keybindings";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

/** Where an unregistered doc link goes instead of nowhere. */
const REPO_BLOB = "https://github.com/lopezz-dev/huginnDB/blob/main";

/**
 * The doc a relative markdown href points at, or `null` when nothing in the
 * registry owns it.
 *
 * Matches on the file name rather than the whole path so `MCP.md`,
 * `./MCP.md` and `docs/MCP.md` all resolve — the docs are written to be read on
 * GitHub from several directories, so all three spellings occur.
 */
function docForHref(href: string): DocEntry | null {
  const file = href.split("#")[0].split("/").pop()?.toLowerCase();
  if (!file?.endsWith(".md")) return null;
  return (
    DOCS.find((d) => d.path.split("/").pop()?.toLowerCase() === file) ?? null
  );
}

/** `md` without its first line when that line is a heading of `level`. */
function withoutHeading(md: string, level: 1 | 2): string {
  const re = level === 1 ? /^\s*#\s+[^\n]*\n+/ : /^\s*##\s+[^\n]*\n+/;
  return md.replace(re, "");
}

export function DocsDialog() {
  const { t, i18n } = useTranslation();
  const open = useDocsDialog((s) => s.open);
  const activeId = useDocsDialog((s) => s.activeId);
  const sectionSlug = useDocsDialog((s) => s.sectionSlug);
  const pendingAnchor = useDocsDialog((s) => s.pendingAnchor);
  const searchFocusRequest = useDocsDialog((s) => s.searchFocusRequest);
  const setOpen = useDocsDialog((s) => s.setOpen);
  const setActive = useDocsDialog((s) => s.setActive);
  const goHome = useDocsDialog((s) => s.goHome);
  const setSection = useDocsDialog((s) => s.setSection);
  const clearAnchor = useDocsDialog((s) => s.clearAnchor);
  const findShortcut = useShortcutLabel("focusFilter");

  const [query, setQuery] = React.useState("");
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [scroller, setScroller] = React.useState<HTMLDivElement | null>(null);

  const active = (activeId && getDoc(activeId)) || null;
  const lang = i18n.language;
  const body = active ? getDocBody(active, lang) : "";
  // Reparsed only when the body changes — a language switch or a different doc,
  // not every render.
  const parsed = React.useMemo<ParsedDoc | null>(
    () => (active ? parseDoc(body) : null),
    [active, body],
  );
  const section = parsed?.sections.find((s) => s.slug === sectionSlug) ?? null;
  const searching = query.trim().length > 0;
  const hits = React.useMemo(
    () => (searching ? searchDocs(query, lang) : []),
    [query, searching, lang],
  );

  // A search left in the box would greet the next opening with a results page
  // instead of the page the caller asked for (the palette, Preferences).
  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // The find key while the viewer is open. Select what is there so typing
  // replaces the last search instead of appending to it.
  React.useEffect(() => {
    if (searchFocusRequest === 0) return;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [searchFocusRequest]);

  const subs = section?.subs ?? [];
  const spied = useScrollSpy(
    searching ? null : scroller,
    React.useMemo(() => subs.map((s) => s.slug), [subs]),
  );

  /**
   * Follow a link the renderer cannot judge alone: an in-document `#anchor`, or
   * a relative path to another `.md`.
   *
   * `canFollow` and `follow` agree by construction because both go through
   * `resolve`. An href that resolves to nothing is left inert and uncoloured
   * rather than navigating somewhere arbitrary.
   */
  const navigator = React.useMemo<DocNavigator>(() => {
    const resolve = (href: string): (() => void) | null => {
      if (href.startsWith("#")) {
        const hit = parsed ? locate(parsed, href.slice(1)) : null;
        return hit ? () => setSection(hit.section, hit.anchor) : null;
      }
      const target = docForHref(href);
      if (target) {
        const anchor = href.split("#")[1];
        return () => {
          if (target.id === active?.id && anchor && parsed) {
            const hit = locate(parsed, anchor);
            if (hit) return setSection(hit.section, hit.anchor);
          }
          setActive(target.id);
        };
      }
      // A doc that exists in the repo but is deliberately not bundled — the
      // roadmaps, SECURITY.md. Hand it to GitHub rather than leaving a link
      // the prose depends on doing nothing. The Tauri capability already
      // allows github.com only, which is where these live.
      if (/\.md(#.*)?$/i.test(href)) {
        const file = href.replace(/^(\.\/|\.\.\/)+/, "");
        const path = href.startsWith("../") ? file : `docs/${file}`;
        return () => void api.openUrl(`${REPO_BLOB}/${path}`);
      }
      return null;
    };
    return {
      canFollow: (href) => resolve(href) !== null,
      follow: (href) => resolve(href)?.(),
    };
  }, [parsed, active?.id, setSection, setActive]);

  const pickHit = (hit: DocHit) => {
    setQuery("");
    useDocsDialog.getState().openTo(hit.docId, hit.section, hit.anchor);
  };

  /** Previous / next within the guide, spilling into the next guide's cover. */
  const pager = React.useMemo<{
    prev: PagerTarget | null;
    next: PagerTarget | null;
  }>(() => {
    if (!active || !parsed) return { prev: null, next: null };
    const sections = parsed.sections;
    const at = section ? sections.indexOf(section) : -1;
    const prevSection = at > 0 ? sections[at - 1] : null;
    const nextSection = sections[at + 1] ?? null;
    const nextDoc = DOCS[DOCS.indexOf(active) + 1] ?? null;
    return {
      prev: section
        ? prevSection
          ? { label: prevSection.title, go: () => setSection(prevSection.slug) }
          : { label: t(active.titleKey), go: () => setSection(null) }
        : null,
      next: nextSection
        ? { label: nextSection.title, go: () => setSection(nextSection.slug) }
        : nextDoc
          ? { label: t(nextDoc.titleKey), go: () => setActive(nextDoc.id) }
          : null,
    };
  }, [active, parsed, section, setSection, setActive, t]);

  const settingsSection = active ? settingsSectionForDoc(active.id) : undefined;

  const actions = active ? (
    <>
      {formatDocDate(active.updated, lang) && (
        <span className="mr-1 text-3xs text-muted-foreground">
          {t("docs.updated", { date: formatDocDate(active.updated, lang) })}
        </span>
      )}
      {settingsSection && (
        <Button
          size="xs"
          variant="outline"
          icon={Settings2}
          onClick={() => {
            setOpen(false);
            useSettingsDialog.getState().openAt(settingsSection);
          }}
        >
          {t("docs.openSettings")}
        </Button>
      )}
      <Button
        size="xs"
        variant="ghost"
        icon={ExternalLink}
        onClick={() => {
          const localized =
            lang !== "en" && active.bodies[lang as keyof typeof active.bodies]
              ? active.path.replace(/\.md$/, `.${lang}.md`)
              : active.path;
          void api.openUrl(`${REPO_BLOB}/${localized}`);
        }}
      >
        {t("docs.viewOnGitHub")}
      </Button>
    </>
  ) : undefined;

  const ActiveIcon = active ? docIcon(active.id) : BookOpen;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        tier="workbench"
        className="flex h-[85vh] max-w-6xl flex-col"
        // Escape clears a search before it closes the dialog, for the reason
        // Preferences does: typing in the rail's box, the user expects it to
        // undo the typing rather than lose the whole dialog.
        onEscapeKeyDown={(e) => {
          if (query) {
            e.preventDefault();
            setQuery("");
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <BookOpen className="h-4 w-4 text-brand" />
            {t("docs.title")}
          </DialogTitle>
          <DialogDescription className="text-2xs">
            {t("docs.subtitle")}{" "}
            {findShortcut && (
              <>
                {t("docs.searchWith")}{" "}
                <Kbd className="px-1 py-0.5 text-3xs">{findShortcut}</Kbd>.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="grid grid-cols-[256px_1fr]">
          <DocsRail
            query={query}
            onQuery={setQuery}
            onSearchEnter={() => hits[0] && pickHit(hits[0])}
            searchRef={searchRef}
            activeId={active?.id ?? null}
            parsed={parsed}
            sectionSlug={section?.slug ?? null}
            searching={searching}
            onHome={() => {
              setQuery("");
              goHome();
            }}
            onDoc={(id) => {
              setQuery("");
              setActive(id);
            }}
            onSection={(slug, anchor) => {
              setQuery("");
              setSection(slug, anchor);
            }}
          />

          <main className="flex min-h-0 min-w-0 flex-col">
            {searching ? (
              <>
                <DocsPageHeader
                  icon={BookOpen}
                  title={t("docs.search.title", { query: query.trim() })}
                  description={t("docs.search.count", { count: hits.length })}
                />
                <div
                  key="search"
                  className="min-h-0 flex-1 overflow-y-auto px-6 pb-6"
                >
                  <DocsSearchResults query={query} hits={hits} onPick={pickHit} />
                </div>
              </>
            ) : !active || !parsed ? (
              <>
                <DocsPageHeader
                  icon={BookOpen}
                  title={t("docs.home")}
                  description={t("docs.homeIntro")}
                />
                <div key="home" className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
                  {DOCS.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("docs.empty")}</p>
                  ) : (
                    <DocsHome
                      onOpen={(id) => {
                        setActive(id);
                      }}
                    />
                  )}
                </div>
              </>
            ) : (
              <>
                <DocsPageHeader
                  icon={ActiveIcon}
                  eyebrow={
                    section ? (
                      <span className="flex items-center gap-1">
                        {t(`docs.groups.${active.group}`)}
                        <span aria-hidden>›</span>
                        <Button
                          variant="link"
                          className="h-auto p-0 text-2xs"
                          onClick={() => setSection(null)}
                        >
                          {t(active.titleKey)}
                        </Button>
                      </span>
                    ) : (
                      t(`docs.groups.${active.group}`)
                    )
                  }
                  title={section ? section.title : t(active.titleKey)}
                  description={section ? undefined : t(active.descriptionKey)}
                  actions={actions}
                />

                <div className="flex min-h-0 min-w-0 flex-1">
                  {/* Keyed so switching page mounts fresh — which also resets
                      the scroll offset, something the single-pane version never
                      did. */}
                  <div
                    key={`${active.id}:${section?.slug ?? "cover"}`}
                    ref={setScroller}
                    className="min-w-0 flex-1 overflow-y-auto px-6 pb-8"
                  >
                    <div className="mx-auto max-w-3xl">
                      {section ? (
                        <>
                          <ScrollToAnchor
                            anchor={pendingAnchor}
                            onConsumed={clearAnchor}
                          />
                          <Markdown
                            source={withoutHeading(section.body, 2)}
                            navigator={navigator}
                            className="[&>*:first-child]:mt-0"
                          />
                        </>
                      ) : (
                        <>
                          <Markdown
                            source={withoutHeading(parsed.cover, 1)}
                            navigator={navigator}
                            className="[&>*:first-child]:mt-0"
                          />
                          {parsed.sections.length > 0 && (
                            <>
                              <h3 className="mb-2 mt-8 border-b pb-1 text-base font-semibold text-foreground">
                                {t("docs.coverSections")}
                              </h3>
                              <div className="grid gap-2 sm:grid-cols-2">
                                {parsed.sections.map((s) => (
                                  <TreeRow
                                    key={s.slug}
                                    onClick={() => setSection(s.slug)}
                                    className={cn(
                                      "items-start gap-2 rounded-md border p-3 text-left transition-colors hover:border-brand/60",
                                      CONTROL_FOCUS_TIGHT,
                                    )}
                                  >
                                    <FileText
                                      aria-hidden
                                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                                    />
                                    <span className="min-w-0">
                                      <span className="block text-sm font-medium text-foreground">
                                        {s.title}
                                      </span>
                                      {s.subs.length > 0 && (
                                        <span className="mt-0.5 block text-2xs leading-snug text-muted-foreground">
                                          {s.subs.map((x) => x.title).join(" · ")}
                                        </span>
                                      )}
                                    </span>
                                  </TreeRow>
                                ))}
                              </div>
                            </>
                          )}
                        </>
                      )}
                      <DocsPager prev={pager.prev} next={pager.next} />
                    </div>
                  </div>
                  <DocsToc
                    subs={subs}
                    active={spied}
                    onPick={(slug) => section && setSection(section.slug, slug)}
                  />
                </div>
              </>
            )}
          </main>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Scroll to `anchor` once the page it belongs to has mounted, then consume it.
 *
 * The `requestAnimationFrame` is the guard `PrefRow` needs for the same reason:
 * the page mounts in the tick that navigated to it, so scrolling immediately
 * lands on an element that has not been laid out yet and has zero height.
 *
 * The anchor is consumed **inside** the frame, after the scroll — not before it,
 * which is the ordering that reads more naturally and does not work. Clearing
 * first updates the store, which changes this effect's dependencies, which runs
 * its cleanup, which cancels the frame that was going to do the scrolling. The
 * effect would tidy up after itself and never scroll at all.
 */
function ScrollToAnchor({
  anchor,
  onConsumed,
}: {
  anchor: string | null;
  onConsumed: () => void;
}) {
  React.useEffect(() => {
    if (!anchor) return;
    const raf = requestAnimationFrame(() => {
      document
        .getElementById(anchor)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
      onConsumed();
    });
    return () => cancelAnimationFrame(raf);
  }, [anchor, onConsumed]);
  return null;
}
