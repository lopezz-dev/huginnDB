import * as React from "react";
import { ChevronRight, Lock, type LucideIcon } from "lucide-react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { cn } from "@/lib/utils";
import { MENU_ITEM, MENU_PANEL, MENU_SUBTRIGGER } from "@/components/ui/styles";

const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
const ContextMenuGroup = ContextMenuPrimitive.Group;
const ContextMenuSub = ContextMenuPrimitive.Sub;
const ContextMenuPortal = ContextMenuPrimitive.Portal;

/**
 * Trigger for a nested submenu. Visually mirrors `ContextMenuItem` so the
 * row keeps the same height and padding, plus a trailing chevron hinting
 * at the expansion. Used by "Copy as ▸ JSON / SQL INSERT / SQL UPDATE".
 */
const ContextMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> & {
    inset?: boolean;
  }
>(({ className, inset, children, ...props }, ref) => (
  <ContextMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(MENU_SUBTRIGGER, "text-xs", inset && "pl-8", className)}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto h-3 w-3 opacity-60" />
  </ContextMenuPrimitive.SubTrigger>
));
ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName;

/**
 * Floating panel rendered next to its `ContextMenuSubTrigger`. Inherits
 * the same chrome as `ContextMenuContent` for visual consistency.
 */
const ContextMenuSubContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.SubContent
    ref={ref}
    className={cn(MENU_PANEL, "min-w-[10rem]", className)}
    {...props}
  />
));
ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName;

const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      className={cn(
        // Same capped-height + scroll treatment as `DropdownMenuContent` (see
        // the note there): a long menu must scroll rather than be clipped.
        MENU_PANEL,
        "min-w-[10rem]",
        className,
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
));
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;

const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(MENU_ITEM, "text-xs", inset && "pl-8", className)}
    {...props}
  />
));
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName;

/**
 * A `ContextMenuItem` with a leading icon, for the common case of a single
 * label + action. Exists so every context menu in the app (grid, connection
 * tree, database tree, table tree) composes the same icon+label+action shape
 * instead of each call site hand-rolling its own `<Icon className="mr-2 …" />`
 * + label pair (which is how `TabbedArea`'s Pin/PinOff item used to do it).
 */
const ContextMenuAction = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  {
    icon: LucideIcon;
    label: string;
    onSelect: () => void;
    disabled?: boolean;
    /** Red styling for irreversible actions (drop, delete, …). */
    destructive?: boolean;
    shortcut?: string;
    /**
     * A short trailing value in the label's own register (a date preview, a
     * count) — muted and monospaced, unlike `shortcut`'s spaced-out keys.
     */
    detail?: string;
    /**
     * Why the managed policy does not allow this (`usePolicyLock`). Disables
     * the item and says so under its label, with a lock — a disabled menu item
     * gets no hover, so a tooltip could never show the reason.
     */
    locked?: string | null;
  }
>(
  (
    { icon: Icon, label, onSelect, disabled, destructive, shortcut, detail, locked },
    ref,
  ) => (
    <ContextMenuItem
      ref={ref}
      disabled={disabled || !!locked}
      onSelect={onSelect}
      className={cn(
        destructive &&
          !locked &&
          "text-destructive focus:bg-destructive/10 focus:text-destructive",
        // Muted rather than half-transparent: the generic disabled fade
        // would take the reason line down with it, and the reason is the
        // point of the item.
        locked &&
          "items-start text-muted-foreground data-[disabled]:opacity-100",
      )}
    >
      <Icon
        className={cn(
          "mr-2 h-3.5 w-3.5 shrink-0",
          // Level with the label's line, not the middle of two lines.
          locked && "mt-px opacity-60",
        )}
      />
      {locked ? (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate">{label}</span>
          <span className="flex items-center gap-1 text-3xs leading-tight text-muted-foreground/80">
            <Lock aria-hidden className="h-2.5 w-2.5 shrink-0" />
            <span>{locked}</span>
          </span>
        </span>
      ) : (
        <span className="truncate">{label}</span>
      )}
      {!locked && detail && (
        <span className="ml-auto shrink-0 pl-4 font-mono text-3xs text-muted-foreground">
          {detail}
        </span>
      )}
      {!locked && shortcut && (
        <ContextMenuShortcut>{shortcut}</ContextMenuShortcut>
      )}
    </ContextMenuItem>
  ),
);
ContextMenuAction.displayName = "ContextMenuAction";

const ContextMenuLabel = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-2 py-1 text-3xs uppercase tracking-wider text-muted-foreground",
      className,
    )}
    {...props}
  />
));
ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName;

/**
 * The menu's subject — a column or field name with small tags beside it (its
 * type, `NULL`) — set apart from the uppercase `ContextMenuLabel`s that title
 * each section below it. Before this, the subject *was* a `ContextMenuLabel`,
 * so a column called `operation` read `OPERATION` and looked like one more
 * section heading.
 */
const ContextMenuHeader = ({
  title,
  tags,
  className,
}: {
  title: string;
  tags?: (string | null | undefined | false)[];
  className?: string;
}) => (
  <ContextMenuPrimitive.Label
    className={cn("flex min-w-0 items-baseline gap-1.5 px-2 pb-1.5 pt-1", className)}
  >
    <span className="min-w-0 truncate font-mono text-2xs font-medium text-foreground">
      {title}
    </span>
    {tags
      ?.filter((tag): tag is string => !!tag)
      .map((tag) => (
        <span
          key={tag}
          className="shrink-0 rounded-sm border border-border px-1 font-mono text-3xs text-muted-foreground"
        >
          {tag}
        </span>
      ))}
  </ContextMenuPrimitive.Label>
);
ContextMenuHeader.displayName = "ContextMenuHeader";

const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-muted", className)}
    {...props}
  />
));
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName;

const ContextMenuShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => (
  <span
    className={cn(
      "ml-auto text-3xs tracking-widest text-muted-foreground",
      className,
    )}
    {...props}
  />
);
ContextMenuShortcut.displayName = "ContextMenuShortcut";

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuAction,
  ContextMenuLabel,
  ContextMenuHeader,
  ContextMenuGroup,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuPortal,
};
