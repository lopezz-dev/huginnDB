/**
 * Post-update "What's new" presentation — a curated, iconified highlights
 * dialog that pops on the first launch after updating to a `major` release
 * (see `stores/whatsNew.ts` + `lib/releaseNotes.ts`). It's the punchy
 * counterpart to the exhaustive changelog in Settings → About
 * (`PatchNotesCard`), not a replacement for it.
 *
 * Controlled entirely by `useWhatsNew`: the dialog is open whenever
 * `openVersion` is set, and closing (button, Esc, overlay, X) routes through
 * `dismiss`, which marks that version seen so it won't reappear.
 *
 * A fresh release is a celebration, not a working surface — one of the few
 * places (with the splash, empty states and About) the visual brief lets the
 * brand speak in full. The header carries the sticker mark over the
 * halftone wash instead of a generic icon, the same device `AboutSection`
 * and `EmptyState` use. Every colour here is a semantic token (`brand`,
 * `card`, `border`, …), so the banner repaints with whatever theme is
 * active — Claude, Neon, Summer, High Contrast, or a custom one — for free.
 *
 * Highlight bodies clamp to two lines with a WhatsApp-style "Read more"
 * toggle (`HighlightBody` below): recent releases (JSON Schemas, MCP write
 * policy) carry enough nuance that the full body regularly runs 4-5 lines,
 * and showing all of them expanded by default drowned the highlight list in
 * text. The toggle only renders when the clamped paragraph actually
 * overflows (`scrollHeight` vs `clientHeight`, measured post-layout) — a
 * short body never grows a dead "Read more" that expands to identical text.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MICRO_HEADING } from "@/components/ui/styles";
import { useWhatsNew } from "@/stores/dialogs/whatsNew";
import { getReleaseNote } from "@/lib/appInfo/releaseNotes";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const CHANGELOG_URL =
  "https://github.com/lopezz-dev/huginnDB/blob/main/CHANGELOG.md";

/** A highlight body: clamped to 2 lines, with a "Read more"/"Read less"
 *  toggle that only appears once the text is confirmed to overflow. */
function HighlightBody({ text }: { text: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [text]);

  return (
    <>
      <p
        ref={ref}
        className={cn(
          "text-xs leading-relaxed text-muted-foreground",
          !expanded && "line-clamp-2",
        )}
      >
        {text}
      </p>
      {overflowing && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-2xs font-semibold text-brand hover:text-brand-hover hover:underline"
        >
          {expanded ? t("whatsNew.readLess") : t("whatsNew.readMore")}
        </button>
      )}
    </>
  );
}

export function WhatsNewDialog() {
  const { t } = useTranslation();
  const openVersion = useWhatsNew((s) => s.openVersion);
  const dismiss = useWhatsNew((s) => s.dismiss);

  const note = openVersion ? getReleaseNote(openVersion) : null;

  return (
    <Dialog
      open={note !== null}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      {note && (
        <DialogContent tier="panel" className="max-w-xl overflow-hidden">
          {/* No `DialogHeader` here: the brand banner below carries the
              title and description itself, at its own `px-7` rhythm rather
              than the tier's `px-5` — the one place in the redesign that
              wants a hunk the tier doesn't model (a celebratory banner, not
              a plain rail), so it is the body's own first child instead of
              a `banner` prop invented for a single consumer. */}
          <DialogBody className="p-0">
            {/* Brand banner: the sticker mark over the halftone wash, same
                language as the splash screen and About's identity card.
                `bg-card/60` over the dialog's own `bg-card` is what keeps the
                dot lattice from reading flat against it. Padding is `pr-8` on
                the title row so the version pill never crowds the dialog's
                own close button, sitting at a fixed `top-3 right-3`. */}
            <div className="relative border-b border-border bg-card/60 px-7 pb-6 pt-7">
              <span
                aria-hidden
                className="halftone-centered pointer-events-none absolute inset-0 opacity-60 [--halftone-pitch:12px]"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute -top-10 left-0 h-40 w-40 rounded-full bg-brand/25 blur-[70px]"
              />
              <div className="relative flex items-center gap-3 pr-8">
                <img
                  src="/image/huginn-mark-256.png"
                  alt=""
                  width={256}
                  height={256}
                  className="h-12 w-12 shrink-0 select-none drop-shadow-[0_4px_16px_color-mix(in_srgb,var(--brand)_35%,transparent)]"
                  draggable={false}
                />
                <div className="min-w-0">
                  <span
                    className={cn(
                      MICRO_HEADING,
                      "inline-flex items-center rounded-full bg-brand/10 px-2 py-0.5 text-brand",
                    )}
                  >
                    {t("whatsNew.versionLabel", { version: note.version })}
                  </span>
                  <DialogTitle className="mt-1 text-xl">
                    {t("whatsNew.title")}
                  </DialogTitle>
                </div>
              </div>
              {/* The hero line: one sentence that says what the release is
                  about, not a summary of every highlight — the list below
                  does that job, each with its own "Read more". */}
              <DialogDescription className="relative mt-4 pr-8 text-[13px] font-medium leading-snug text-foreground/90">
                {t(note.taglineKey)}
              </DialogDescription>
            </div>

            <div className="px-7 py-4">
              <ul className="-mx-1 max-h-[50vh] space-y-1 overflow-y-auto px-1">
                {note.highlights.map((h, i) => {
                  const Icon = h.icon;
                  return (
                    <li
                      key={h.titleKey}
                      className="flex items-start gap-3 rounded-md p-2 opacity-0 [animation-fill-mode:forwards] animate-pop-in transition-colors hover:bg-accent"
                      style={{ animationDelay: `${i * 45}ms` }}
                    >
                      <span className="brand-sticker mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground">
                          {t(h.titleKey)}
                        </div>
                        <HighlightBody text={t(h.bodyKey)} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </DialogBody>

          <DialogFooter className="items-center px-7 py-4 sm:justify-between">
            {/* `px-0`: the link's text sits flush with the body's `px-7`
                column above it, as plain link text does. */}
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => void api.openUrl(CHANGELOG_URL)}
              className="px-0"
            >
              {t("whatsNew.viewChangelog")}
            </Button>
            <Button size="sm" onClick={dismiss}>
              {t("whatsNew.gotIt")}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
