/**
 * The viewer's left rail: a search box, the home page, then the guides under
 * their group headings — the same anatomy as Preferences' rail, so the two
 * dialogs read as one family.
 *
 * The open guide unfolds into its pages (the cover and one row per `##`), and
 * the open page's `###`s hang under it, but only below `xl`: from there up the
 * "On this page" column shows them (`DocsToc`), and listing them twice would be
 * the one place the two disagree when a heading is renamed.
 */

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Home } from "lucide-react";
import { DOC_GROUPS, docsInGroup } from "@/lib/appInfo/docs";
import type { ParsedDoc } from "@/lib/appInfo/docOutline";
import { NavRailItem } from "@/components/ui/nav-rail";
import { SearchField } from "@/components/ui/search-field";
import { TreeRow } from "@/components/ui/tree-row";
import { CONTROL_FOCUS_TIGHT, MICRO_HEADING } from "@/components/ui/styles";
import { cn } from "@/lib/utils";
import { docIcon } from "./docIcons";

interface Props {
  query: string;
  onQuery: (query: string) => void;
  onSearchEnter: () => void;
  searchRef: React.Ref<HTMLInputElement>;
  /** `null` is the home page. */
  activeId: string | null;
  /** The active guide's outline; `null` on the home page. */
  parsed: ParsedDoc | null;
  sectionSlug: string | null;
  /** While a search is showing, nothing in the rail is "current". */
  searching: boolean;
  onHome: () => void;
  onDoc: (id: string) => void;
  onSection: (slug: string | null, anchor?: string) => void;
}

/**
 * One child in the rail's tree, drawn with a rounded elbow from its parent's
 * spine instead of a flat rule down the whole list: the line runs past a row
 * only while it has a sibling below, so the last child ends in the curve and
 * the shape says "this is where the guide ends". The elbow sits at the height
 * of the row's first line (`h-3`), so a wrapped title still hangs off its top.
 */
function Branch({
  last,
  active,
  children,
}: {
  last: boolean;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="relative pb-0.5 pl-3 last:pb-0">
      {!last && (
        <span
          aria-hidden
          className="absolute bottom-0 left-0 top-0 border-l border-muted-foreground/35"
        />
      )}
      <span
        aria-hidden
        className={cn(
          "absolute left-0 top-0 h-3 w-2.5 rounded-bl-md border-b border-l",
          active ? "border-brand" : "border-muted-foreground/35",
        )}
      />
      {children}
    </li>
  );
}

function PageRow({
  label,
  active,
  depth = 1,
  onClick,
}: {
  label: string;
  active: boolean;
  depth?: 1 | 2;
  onClick: () => void;
}) {
  return (
    <TreeRow
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-md py-1 pl-1.5 pr-2 text-left leading-snug transition-colors",
        CONTROL_FOCUS_TIGHT,
        depth === 1 ? "text-xs" : "text-2xs",
        active
          ? "bg-brand/10 text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </TreeRow>
  );
}

export function DocsRail({
  query,
  onQuery,
  onSearchEnter,
  searchRef,
  activeId,
  parsed,
  sectionSlug,
  searching,
  onHome,
  onDoc,
  onSection,
}: Props) {
  const { t } = useTranslation();
  const section = parsed?.sections.find((s) => s.slug === sectionSlug) ?? null;

  return (
    <aside className="flex min-h-0 flex-col border-r border-border bg-card/40">
      <div className="shrink-0 p-2 pb-1">
        <SearchField
          ref={searchRef}
          value={query}
          onValueChange={onQuery}
          onClear={() => onQuery("")}
          clearLabel={t("docs.search.clear")}
          size="sm"
          placeholder={t("docs.search.placeholder")}
          aria-label={t("docs.search.label")}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSearchEnter();
          }}
        />
      </div>
      <nav
        aria-label={t("docs.title")}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2"
      >
        <NavRailItem
          icon={Home}
          label={t("docs.home")}
          active={!searching && activeId === null}
          onClick={onHome}
        />
        {DOC_GROUPS.map((group) => {
          const docs = docsInGroup(group);
          if (docs.length === 0) return null;
          return (
            <div key={group} className="space-y-0.5">
              <div className={cn(MICRO_HEADING, "px-2.5 pb-1")}>
                {t(`docs.groups.${group}`)}
              </div>
              {docs.map((doc) => {
                const open = doc.id === activeId;
                return (
                  <React.Fragment key={doc.id}>
                    <NavRailItem
                      icon={docIcon(doc.id)}
                      label={t(doc.titleKey)}
                      active={!searching && open && sectionSlug === null}
                      aria-expanded={open}
                      onClick={() => onDoc(doc.id)}
                    />
                    {open && parsed && (
                      <ul className="ml-[18px]">
                        {parsed.sections.map((s, i) => {
                          const current = !searching && s.slug === sectionSlug;
                          return (
                            <Branch
                              key={s.slug}
                              last={i === parsed.sections.length - 1}
                              active={current}
                            >
                              <PageRow
                                label={s.title}
                                active={current}
                                onClick={() => onSection(s.slug)}
                              />
                              {s.slug === section?.slug && s.subs.length > 0 && (
                                <ul className="ml-1.5 mt-0.5 xl:hidden">
                                  {s.subs.map((sub, j) => (
                                    <Branch
                                      key={sub.slug}
                                      last={j === s.subs.length - 1}
                                      active={false}
                                    >
                                      <PageRow
                                        label={sub.title}
                                        depth={2}
                                        active={false}
                                        onClick={() => onSection(s.slug, sub.slug)}
                                      />
                                    </Branch>
                                  ))}
                                </ul>
                              )}
                            </Branch>
                          );
                        })}
                      </ul>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
