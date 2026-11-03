/**
 * Previous / next pinned under the page, so reading a guide through is a series
 * of clicks at the same spot, not a trip back to the rail after every section.
 * The bar sits outside the scroller and each button has a fixed width, so
 * neither a short page nor a long title moves it.
 *
 * The last page of a guide offers the next guide's cover, and the first offers
 * nothing — the home page is one click away in the rail, and a "previous" that
 * sometimes meant "up" would not be a pager.
 */

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export interface PagerTarget {
  /** What the reader is going to: a section title, or a guide's title. */
  label: string;
  go: () => void;
}

export function DocsPager({
  prev,
  next,
}: {
  prev: PagerTarget | null;
  next: PagerTarget | null;
}) {
  const { t } = useTranslation();
  if (!prev && !next) return null;
  return (
    <nav
      aria-label={t("docs.pager")}
      className="shrink-0 border-t border-border bg-card/40 px-6 py-3"
    >
      <div className="mx-auto flex max-w-3xl items-stretch justify-between gap-3">
        {prev ? (
          <Button
            variant="outline"
            onClick={prev.go}
            className="h-auto w-64 min-w-0 max-w-[48%] flex-col items-start gap-0.5 py-2 text-left"
          >
            <span className="flex items-center gap-1 text-3xs uppercase tracking-wide text-muted-foreground">
              <ChevronLeft aria-hidden className="h-3 w-3" />
              {t("docs.previous")}
            </span>
            <span className="max-w-full truncate text-sm">{prev.label}</span>
          </Button>
        ) : (
          <span />
        )}
        {next ? (
          <Button
            variant="outline"
            onClick={next.go}
            className="h-auto w-64 min-w-0 max-w-[48%] flex-col items-end gap-0.5 py-2 text-right"
          >
            <span className="flex items-center gap-1 text-3xs uppercase tracking-wide text-muted-foreground">
              {t("docs.next")}
              <ChevronRight aria-hidden className="h-3 w-3" />
            </span>
            <span className="max-w-full truncate text-sm">{next.label}</span>
          </Button>
        ) : (
          <span />
        )}
      </div>
    </nav>
  );
}
