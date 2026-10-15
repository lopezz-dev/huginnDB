/**
 * One connection row in the manager's rail.
 *
 * Split out of `ConnectionRail` when provenance arrived: the row grew a
 * shared-origin badge and a protected (uncheckable) state on top of the
 * selection checkbox, the live-pool dot and the driver badge, which is more than
 * a closure inside another component's body should carry (convention #28).
 *
 * A `<div role="button">` rather than a `<button>` so the selection
 * `<input type="checkbox">` can nest legally inside it.
 */

import { useTranslation } from "react-i18next";
import { FolderSync } from "lucide-react";

import { DriverBadge } from "@/components/common/DriverBadge";
import { VanishedOriginMark } from "@/components/common/VanishedOriginNotice";
import { Checkbox } from "@/components/ui/checkbox";
import { sqliteFileLabel } from "@/lib/connectionLabel";
import { isFromOrigin } from "@/lib/connection/origin";
import { effectivePort } from "@/lib/db/driver";
import { cn } from "@/lib/utils";
import type { ConnectionProfile } from "@/types";

export function ConnectionRailRow({
  profile,
  active,
  editing,
  checked,
  multi,
  showOriginBadge,
  originName,
  onClick,
  onToggle,
  onOpen,
}: {
  profile: ConnectionProfile;
  /** Has a live pool — drives the status dot. */
  active: boolean;
  /** Open in the editor beside the rail. */
  editing: boolean;
  checked: boolean;
  /** More than one row is checked, so the row gets the multi-select tint. */
  multi: boolean;
  /**
   * Whether to mark a shared row with the origin badge. False in the Shared
   * scope, where the section header already names the origin — repeating it per
   * row would be noise.
   */
  showOriginBadge: boolean;
  /** Registered name of the publishing origin, or `null` if it is unregistered. */
  originName: string | null;
  onClick: (e: React.MouseEvent) => void;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const shared = isFromOrigin(profile);
  const subline =
    profile.driver === "sqlite"
      ? sqliteFileLabel(profile.database)
      : profile.driver === "mongodb"
        ? profile.connection_string ||
          `${profile.host}:${effectivePort(profile.driver, profile.port)}`
        : `${profile.host}:${effectivePort(profile.driver, profile.port)}/${profile.database}`;

  // A shared profile can't be bulk-deleted: the backend refuses the id, because
  // the next sync would recreate it from the published file anyway. The checkbox
  // is rendered and disabled rather than omitted — an absent control reads as a
  // render bug, whereas a disabled one with this tooltip says why and where to
  // go instead.
  const protectedRow = shared;
  const protectedTitle = originName
    ? t("connections.originProtectedTooltip", { origin: originName })
    : t("connections.originProtectedTooltipUnknown");

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group/row flex w-full cursor-pointer items-center gap-2 border-l-2 px-3 py-2 text-left transition-colors",
        editing
          ? "border-primary bg-accent/40"
          : "border-transparent hover:bg-accent",
        checked && multi && "bg-accent/60",
      )}
    >
      {/* Checkbox reveals on hover / when selected; otherwise the live
          "connected" status dot occupies the same slot (grid convention). */}
      <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <Checkbox
          checked={checked}
          disabled={protectedRow}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          aria-label={t("connections.selectConnection", { name: profile.name })}
          title={protectedRow ? protectedTitle : undefined}
          className={cn(
            // Only the visibility rule is left here: the disabled cursor and
            // dimming come from the primitive.
            checked ? "inline-block" : "hidden group-hover/row:inline-block",
          )}
        />
        <span
          className={cn(
            "absolute h-1.5 w-1.5 rounded-full",
            active ? "bg-brand" : "bg-muted-foreground/40",
            checked ? "hidden" : "group-hover/row:hidden",
          )}
          title={active ? t("connections.disconnectTooltip") : undefined}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{profile.name}</span>
          <DriverBadge driver={profile.driver} />
          {showOriginBadge && shared && (
            <span
              className="flex shrink-0 items-center"
              title={
                originName
                  ? t("connections.sharedBadgeTooltip", { origin: originName })
                  : t("connections.sharedBadgeTooltipUnknown")
              }
            >
              <FolderSync className="h-3 w-3 text-muted-foreground" />
            </span>
          )}
          {/* Amber unlink: this one's origin stopped publishing it, which is a
              different state from "shared and healthy" and needs a different
              glyph, not a different tooltip on the same one. */}
          <VanishedOriginMark profileId={profile.id} />
        </div>
        <div className="truncate text-2xs text-muted-foreground">{subline}</div>
      </div>
    </div>
  );
}
