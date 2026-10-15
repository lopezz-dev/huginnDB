import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { CONTROL_FOCUS } from "@/components/ui/styles";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // Opaque hex `--scrim` run through the same alpha the utility picks
      // per mode: one alpha cannot both dim a light page and darken an
      // already-dark one. See the token's docblock in `lib/themes.ts`.
      "fixed inset-0 z-50 bg-scrim/35 backdrop-blur-sm dark:bg-scrim/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/**
 * The dialog's anatomy — chrome (padding, radius, shadow, header/footer
 * rail) rather than content. Picked once, by whoever writes the call site,
 * and read by `DialogHeader` / `DialogBody` / `DialogFooter` via
 * `DialogTierContext` below instead of being redeclared at each slot: a
 * call site says `tier="panel"` and *cannot* re-declare the rail, the
 * padding, the radius or the close-button gap, which is exactly what seven
 * hand-copied header rails (five spellings between them) used to invite.
 *
 * A prop, not a `surfaceFor` derived from `children`: the tier a dialog
 * wants is known statically by whoever writes it, not derivable at runtime
 * from its content (ADR #64 is about the latter kind of decision, not
 * this one) — and inspecting `React.Children` to guess it would break the
 * moment someone wraps the body in a fragment, silently, as a wrong
 * anatomy rather than a build error.
 *
 * There used to be a fourth, transitional `padded` variant here — byte
 * identical to the single pre-tier anatomy every `DialogContent` call site
 * resolved to, so introducing the other three tiers could be a
 * visual-change-zero commit before any call site had to be touched. Its
 * `uiAdoption.test.ts` census (call sites still on it) reached `{}` once
 * every domain migration landed, which is the signal that variant existed
 * to produce — so it and the census are both gone, and `panel` (the most
 * common real tier) is the default now.
 */
const dialogContentVariants = cva(
  "pointer-events-auto grid w-full border [&>*]:min-w-0 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:zoom-in-[0.98]",
  {
    variants: {
      tier: {
        // The ~11 one-line confirms/prompts: small, no stacked description
        // slot, no header rail. 8px — the tab chip's radius, the app's
        // existing "small surface" reference — not the island's 10px.
        prompt: "max-w-[400px] rounded-md bg-card p-0 shadow-elevation-3",
        // The ~18 forms — the default. 10px, the island's own radius, which
        // is what anchors this as related chrome rather than another
        // web-card floating on top of it.
        panel: "max-w-md rounded-lg bg-card p-0 shadow-elevation-3",
        // Settings / Connection / OriginEditorOverlay / Docs /
        // CellEditor-fullscreen: a `p-2` inset onto the app's own trench
        // canalour, borrowing the workspace island's own border, fill and
        // lift (`shadow-island`, added in the previous commit) so a
        // full-screen dialog reads as that island lifted out rather than a
        // foreign card dropped on top of it.
        workbench:
          "h-full w-full max-w-none overflow-hidden rounded-lg border-border bg-background p-0 shadow-island",
      },
    },
    defaultVariants: { tier: "panel" },
  },
);

type DialogTier = NonNullable<
  VariantProps<typeof dialogContentVariants>["tier"]
>;

/**
 * Private — not exported. `DialogHeader`/`DialogBody`/`DialogFooter` read
 * it to pick their own chrome; nothing else should need a dialog's tier.
 */
const DialogTierContext = React.createContext<DialogTier>("panel");

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> &
    VariantProps<typeof dialogContentVariants>
>(({ className, children, tier, ...props }, ref) => {
  const resolvedTier: DialogTier = tier ?? "panel";
  return (
    <DialogPortal>
      <DialogOverlay />
      {/* Centring lives on this layer, not on the content's own `transform`:
          `tailwindcss-animate`'s `enter` keyframe writes `transform:
          translate3d(...) scale3d(...)`, which *replaces* a transform-based
          centring during the 200ms it runs — every dialog used to enter from
          the viewport's top-left corner. Aligning a flex container instead
          leaves `transform` free for the animation, lets a dialog taller than
          the viewport scroll instead of clipping at both edges, and turns each
          tier's geometry into an alignment rather than translate arithmetic.
          `pointer-events-none` here (the content below opts back in) is what
          keeps the outside click landing on the overlay instead of this
          layer. */}
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-2">
        <DialogTierContext.Provider value={resolvedTier}>
          <DialogPrimitive.Content
            ref={ref}
            className={cn(
              // `[&>*]:min-w-0` is load-bearing, not tidying — see the base
              // class above. This is a grid (or, for a tier with its own
              // header/body/footer slots, a flex column with the same
              // problem): a child too wide to fit widens the implicit
              // track *past* `max-w-*` instead of shrinking, and because
              // every other item stretches to that track, one overwide
              // child drags all its siblings out over the dialog's own
              // border. A footer of four `whitespace-nowrap` buttons did
              // exactly that. Zeroing the minimum makes the offending
              // child shrink instead.
              //
              // `max-w-md`, not shadcn's `max-w-lg`: of the 31 call sites
              // that used to override this, 15 passed `max-w-md` and only
              // 3 wanted the `lg` default — corrected here as `panel`'s own
              // width. The remaining widths are all one-offs (`2xl`, `4xl`,
              // `6xl`, viewport-relative) that read fine as explicit
              // overrides; `tailwind-merge` lets those win, `className`
              // being last.
              dialogContentVariants({ tier: resolvedTier }),
              className,
            )}
            {...props}
          >
            {children}
            {/* Proper close affordance: a padded button with a hover
                background, rather than a bare low-opacity glyph with no
                hit area. */}
            <DialogPrimitive.Close
              className={cn(
                "absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none",
                CONTROL_FOCUS,
              )}
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </DialogTierContext.Provider>
      </div>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  const tier = React.useContext(DialogTierContext);
  return (
    <div
      ref={ref}
      className={cn(
        "flex text-left",
        tier === "prompt" && "flex-row items-center gap-3 p-4 pb-2 pr-10",
        (tier === "panel" || tier === "workbench") &&
          "flex-col space-y-1.5 border-b border-border px-5 py-3 pr-10",
        className,
      )}
      {...props}
    />
  );
});
DialogHeader.displayName = "DialogHeader";

/**
 * The scrolling content area between the header rail and the footer.
 * Padding lives here rather than on `DialogContent` (which is `p-0` for
 * every real tier) so the header and footer's own borders reach edge to
 * edge instead of stopping short of a shared padded box.
 *
 * `panel` is the only tier that scrolls here: `workbench` hosts dialogs
 * whose own body already manages its own scroll regions (`SettingsDialog`'s
 * side-by-side panels, `ConnectionDialog`'s tabs), so a second
 * `overflow-y-auto` boundary here would fight theirs rather than replace
 * it — see the risk note in the dialog-redesign ADR.
 */
const DialogBody = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  const tier = React.useContext(DialogTierContext);
  return (
    <div
      ref={ref}
      className={cn(
        tier === "prompt" && "px-4 pb-4 text-xs text-muted-foreground",
        tier === "panel" && "min-h-0 overflow-y-auto px-5 py-4",
        tier === "workbench" && "min-h-0 flex-1 overflow-hidden",
        className,
      )}
      {...props}
    />
  );
});
DialogBody.displayName = "DialogBody";

/**
 * `flex-wrap` + `gap-2` rather than `space-x-2`: buttons are
 * `whitespace-nowrap`, so a row of them that outgrows the dialog used to push
 * the grid column wide instead of wrapping (see `dialogContentVariants`).
 * The two go together — `space-x-*` only adds a left margin, so a wrapped
 * second row would sit flush against the first.
 *
 * `gap-2` renders identically to `space-x-2` for a row that does not wrap, so
 * this changes nothing for the footers that already fit.
 */
const DialogFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  const tier = React.useContext(DialogTierContext);
  return (
    <div
      ref={ref}
      className={cn(
        "flex flex-wrap justify-end gap-2",
        tier === "prompt" && "p-4 pt-0",
        (tier === "panel" || tier === "workbench") &&
          "border-t border-border px-5 py-3",
        className,
      )}
      {...props}
    />
  );
});
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
export type { DialogTier };
