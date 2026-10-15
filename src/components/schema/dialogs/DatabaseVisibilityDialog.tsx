/**
 * DataGrip-style "choose which databases to show" picker (#64).
 *
 * "All selected" stores `null` so newly-created databases keep appearing
 * automatically, and save is disabled with nothing selected — an empty subset
 * would hide the whole tree, which is never what the user wants.
 *
 * Where the subset lands is the user's choice, because the two scopes answer
 * different questions. **This environment** (the default) writes an override
 * onto `LaunchState.databaseVisibility`, so the same test server can show every
 * replica in one environment and a single client's database in another — the
 * thing that was impossible while the subset lived only on the (global)
 * profile. **All environments** writes `visible_databases` on the profile,
 * which is also what travels through export/import and shared origins, and
 * clears any local override so the choice is visibly in effect here too.
 *
 * A profile published by a shared origin (`origin_id`) is read-only, so only
 * the environment scope is offered for it: a profile-scoped save would be
 * silently undone by the next sync.
 *
 * See ADR #27 for why `undefined` (no override) and `null`
 * (override to "show all") must stay distinct all the way down.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogActions } from "@/components/ui/dialog-actions";
import { Segmented } from "@/components/ui/segmented";
import { useAsyncSubmit } from "@/lib/useAsyncSubmit";
import { useMultiSelect } from "@/lib/useMultiSelect";
import { isFromOrigin } from "@/lib/connection/origin";
import { useConnections } from "@/stores/session/connections";
import { persistLaunchState } from "@/stores/session/persistedTabs";
import { useUi } from "@/stores/session/ui";

export function DatabaseVisibilityDialog({
  profileId,
  databases,
  onClose,
}: {
  profileId: string;
  /** Every database name currently known for the connection. */
  databases: string[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const profile = useConnections((s) =>
    s.profiles.find((p) => p.id === profileId),
  );
  const override = useUi((s) => s.databaseVisibility[profileId]);
  const hasOverride = override !== undefined;
  const fromProfile = profile?.visible_databases ?? null;
  const selected = hasOverride ? override : fromProfile;
  const fromOrigin = isFromOrigin(profile);
  const [scope, setScope] = useState<"environment" | "profile">(() => {
    // Editing happens where the value the user is looking at actually lives, so
    // tweaking an existing filter doesn't silently fork it into two layers. The
    // exception is a value that doesn't exist yet: a brand-new subset defaults
    // to this environment — the narrower, reversible choice, and the one people
    // expect (assuming otherwise is what made the original bug a surprise).
    if (hasOverride || fromOrigin) return "environment";
    return fromProfile ? "profile" : "environment";
  });
  // `selected ?? databases` as the seed: no filter at either layer means
  // "everything", which is what the checklist must open showing.
  const {
    selected: sel,
    allSelected,
    toggle,
    toggleAll,
  } = useMultiSelect(databases, selected);
  const { submitting, error, run } = useAsyncSubmit();

  /** Write the launch state so the override survives a restart / switch. */
  const persist = () =>
    persistLaunchState(Array.from(useConnections.getState().active));

  const submit = () => {
    if (sel.size === 0) return;
    run(async () => {
      const chosen = databases.filter((n) => sel.has(n));
      // "All" → null so future databases stay visible; a proper subset is
      // stored verbatim. At environment scope the `null` is still recorded as an
      // override (the key stays present), which is how this environment shows
      // everything while the profile keeps a narrower default for the others.
      const value = chosen.length === databases.length ? null : chosen;
      if (scope === "profile") {
        const stored = useConnections
          .getState()
          .profiles.find((p) => p.id === profileId);
        if (stored) {
          await useConnections.getState().save({
            ...stored,
            visible_databases: value,
          });
        }
        // Drop the local override, or the user picks "all environments" and
        // sees nothing change here — the override would keep winning.
        if (hasOverride) {
          useUi.getState().setDatabaseVisibilityFor(profileId, undefined);
          await persist();
        }
      } else {
        // "Show everything here" on top of a connection that already shows
        // everything is an override that overrides nothing — drop the key
        // instead of persisting a no-op that outlives the profile's default.
        const local =
          value === null && fromProfile === null ? undefined : value;
        useUi.getState().setDatabaseVisibilityFor(profileId, local);
        await persist();
      }
      onClose();
    });
  };

  /** Discard this environment's override and fall back to the profile's subset. */
  const clearOverride = () => {
    run(async () => {
      useUi.getState().setDatabaseVisibilityFor(profileId, undefined);
      await persist();
      onClose();
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent tier="panel">
        <DialogHeader>
          <DialogTitle>{t("schema.selectDatabases.title")}</DialogTitle>
          <DialogDescription>
            {t("schema.selectDatabases.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
        <div className="space-y-1.5 rounded-md border border-border bg-muted/30 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {t("schema.selectDatabases.scopeLabel")}
            </span>
            {/* No control at all for an origin-published connection — a
                one-option segmented strip reads as a dead toggle. The hint
                below says why the choice isn't there. */}
            {fromOrigin ? (
              <span className="text-xs font-medium">
                {t("schema.selectDatabases.scopeEnvironment")}
              </span>
            ) : (
              <Segmented
                size="sm"
                aria-label={t("schema.selectDatabases.scopeLabel")}
                value={scope}
                onValueChange={setScope}
                options={[
                  {
                    value: "environment" as const,
                    label: t("schema.selectDatabases.scopeEnvironment"),
                  },
                  {
                    value: "profile" as const,
                    label: t("schema.selectDatabases.scopeProfile"),
                  },
                ]}
              />
            )}
          </div>
          <p className="text-2xs text-muted-foreground">
            {fromOrigin
              ? t("schema.selectDatabases.scopeOriginHint")
              : scope === "environment"
                ? t("schema.selectDatabases.scopeEnvironmentHint")
                : t("schema.selectDatabases.scopeProfileHint")}
          </p>
          {hasOverride && (
            <Button
              variant="link"
              size="xs"
              className="h-auto p-0 text-2xs"
              onClick={clearOverride}
              disabled={submitting}
            >
              {t("schema.selectDatabases.useProfileDefault")}
            </Button>
          )}
        </div>
        <div className="flex items-center justify-between pb-1">
          <span className="text-xs text-muted-foreground">
            {t("schema.selectDatabases.count", {
              selected: sel.size,
              total: databases.length,
            })}
          </span>
          <Button
            variant="link"
            size="xs"
            className="h-auto p-0"
            onClick={toggleAll}
          >
            {allSelected
              ? t("schema.selectDatabases.deselectAll")
              : t("schema.selectDatabases.selectAll")}
          </Button>
        </div>
        <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {databases.map((name) => (
            <label
              key={name}
              className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/50"
            >
              <Checkbox checked={sel.has(name)} onChange={() => toggle(name)} />
              <span className="flex-1 truncate text-xs">{name}</span>
            </label>
          ))}
        </div>
        {error && <div className="text-xs text-destructive">{error}</div>}
        </DialogBody>
        <DialogActions
          onCancel={onClose}
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.save")}
          onConfirm={submit}
          confirmDisabled={submitting || sel.size === 0}
        />
      </DialogContent>
    </Dialog>
  );
}
