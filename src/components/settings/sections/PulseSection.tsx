/**
 * Pulse settings: the sampler's own knobs, plus which connections it
 * watches.
 *
 * The picker is a tree grouped by provenance, mirroring `McpSection`'s —
 * same reasoning: a connection a shared origin publishes keeps the same id
 * on every machine, and grouping by where a profile came from is how the
 * connection rail itself reads, so this panel and that rail can't drift on
 * labels or ordering.
 *
 * `pulse.enabled` is the module switch: off hides Pulse from the activity bar,
 * the View menu, the palette and the shortcuts, and idles the sampler — the
 * per-connection opt-ins below are kept for when it comes back on.
 *
 * Every other field composes with `ConnectionProfile.pulse_enabled`: a
 * connection with the sampler off costs nothing here no matter how the
 * intervals below are tuned, and none of these intervals do anything until
 * at least one connection opts in.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/tauri";
import { notify } from "@/lib/notify";
import {
  filterByScope,
  isFromOrigin,
  originIdOf,
  type ProfileScope,
} from "@/lib/connection/origin";
import { buildRailSections } from "@/lib/connection/railSections";
import { useOrigins } from "@/stores/sync/origins";
import {
  usePreferences,
  selectPulsePrefs,
} from "@/stores/preferences/preferences";
import type { ConnectionProfile } from "@/types";
import { ConnectionTreeCard } from "./ConnectionTreeCard";
import { PrefGroup } from "./PrefGroup";
import { PrefRow } from "./PrefRow";
import { PulseConnectionTree } from "./PulseConnectionTree";

export function PulseSection() {
  const { t } = useTranslation();
  const pulse = usePreferences(selectPulsePrefs);
  const updatePulse = usePreferences((s) => s.updatePulse);

  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<ProfileScope>("all");

  useEffect(() => {
    void api
      .listProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  const shared = useMemo(() => profiles.filter(isFromOrigin), [profiles]);
  const hasShared = shared.length > 0;
  useEffect(() => {
    if (!hasShared && scope !== "all") setScope("all");
  }, [hasShared, scope]);

  const filteredProfiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const inScope = filterByScope(profiles, scope);
    if (!q) return inScope;
    return inScope.filter((p) => p.name.toLowerCase().includes(q));
  }, [profiles, filter, scope]);

  const originsById = useOrigins((s) => s.byId);
  const sections = useMemo(() => {
    const nameOf = (id: string) => originsById[id]?.name ?? null;
    const labels = {
      shared: (origin: string) => t("connections.sharedSection", { origin }),
      orphaned: t("connections.orphanedSection"),
    };
    return [
      ...buildRailSections(filteredProfiles, "local", nameOf, labels).map(
        (section) => ({ ...section, label: t("settings.mcp.localSection") }),
      ),
      ...buildRailSections(filteredProfiles, "shared", nameOf, labels),
    ];
  }, [filteredProfiles, originsById, t]);

  const sharedTooltip = (p: ConnectionProfile) => {
    const name = originsById[originIdOf(p) ?? ""]?.name;
    return name
      ? t("connections.sharedBadgeTooltip", { origin: name })
      : t("connections.sharedBadgeTooltipUnknown");
  };

  /**
   * Persist one or more profiles' opt-in. Optimistic, resynced from disk on
   * failure — same shape as `McpSection.setWritePolicy`, and for the same
   * reason it goes through a dedicated command rather than `saveProfile`:
   * this writes the one field it means to, nothing else in the record.
   */
  async function setEnabled(ids: string[], enabled: boolean) {
    const wanted = new Set(ids);
    setProfiles((prev) =>
      prev.map((p) =>
        wanted.has(p.id) ? { ...p, pulse_enabled: enabled } : p,
      ),
    );
    try {
      await api.setPulseEnabled(ids, enabled);
    } catch (e) {
      notify.error(String(e));
      void api
        .listProfiles()
        .then(setProfiles)
        .catch(() => {});
    }
  }

  /** Commit a numeric field, ignoring the intermediate garbage a
   *  partially-typed number produces. */
  const numeric =
    (apply: (n: number) => void, min: number, max: number) => (raw: string) => {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= min && n <= max) apply(n);
    };

  return (
    <div className="space-y-5 text-sm">
      <p className="text-xs text-muted-foreground">
        {t("settings.pulse.intro")}
      </p>

      <PrefGroup title={t("settings.rowGroups.module")}>
        <PrefRow
          label={t("settings.pulse.enabled.label")}
          prefId="pulse.enabled"
          description={t("settings.pulse.enabled.desc")}
        >
          <Switch
            checked={pulse.enabled}
            onCheckedChange={(v) => updatePulse({ enabled: v })}
            aria-label={t("settings.pulse.enabled.label")}
          />
        </PrefRow>
      </PrefGroup>

      <PrefGroup title={t("settings.rowGroups.sampling")}>
        <PrefRow
          label={t("settings.pulse.historyIntervalSecs.label")}
          prefId="pulse.historyIntervalSecs"
          description={t("settings.pulse.historyIntervalSecs.desc")}
          htmlFor="prefs-pulse-history-interval"
        >
          <Input
            id="prefs-pulse-history-interval"
            type="number"
            min={10}
            max={3600}
            step={10}
            value={pulse.historyIntervalSecs}
            onChange={(e) =>
              numeric(
                (n) => updatePulse({ historyIntervalSecs: n }),
                10,
                3600,
              )(e.target.value)
            }
            className="h-8 w-24 text-right font-mono text-xs"
          />
        </PrefRow>

        <PrefRow
          label={t("settings.pulse.retentionDays.label")}
          prefId="pulse.retentionDays"
          description={t("settings.pulse.retentionDays.desc")}
          htmlFor="prefs-pulse-retention"
        >
          <Input
            id="prefs-pulse-retention"
            type="number"
            min={1}
            max={365}
            value={pulse.retentionDays}
            onChange={(e) =>
              numeric(
                (n) => updatePulse({ retentionDays: n }),
                1,
                365,
              )(e.target.value)
            }
            className="h-8 w-24 text-right font-mono text-xs"
          />
        </PrefRow>

        <PrefRow
          label={t("settings.pulse.maxDiskMb.label")}
          prefId="pulse.maxDiskMb"
          description={t("settings.pulse.maxDiskMb.desc")}
          htmlFor="prefs-pulse-max-disk"
        >
          <Input
            id="prefs-pulse-max-disk"
            type="number"
            min={0}
            max={10000}
            value={pulse.maxDiskMb}
            onChange={(e) =>
              numeric(
                (n) => updatePulse({ maxDiskMb: n }),
                0,
                10000,
              )(e.target.value)
            }
            className="h-8 w-24 text-right font-mono text-xs"
          />
        </PrefRow>

        <PrefRow
          label={t("settings.pulse.sampleWhenMinimized.label")}
          prefId="pulse.sampleWhenMinimized"
          description={t("settings.pulse.sampleWhenMinimized.desc")}
        >
          <Switch
            checked={pulse.sampleWhenMinimized}
            onCheckedChange={(v) => updatePulse({ sampleWhenMinimized: v })}
          />
        </PrefRow>
      </PrefGroup>

      <ConnectionTreeCard
        title={t("settings.pulse.connectionsLabel")}
        count={t("settings.pulse.enabledCount", {
          enabled: profiles.filter((p) => p.pulse_enabled).length,
          total: profiles.length,
        })}
        total={profiles.length}
        sharedCount={shared.length}
        scope={scope}
        onScopeChange={setScope}
        filter={filter}
        onFilterChange={setFilter}
        bulkLabel={
          filteredProfiles.every((p) => p.pulse_enabled)
            ? t("settings.pulse.disableAll")
            : t("settings.pulse.enableAll")
        }
        onBulk={() =>
          void setEnabled(
            filteredProfiles.map((p) => p.id),
            !filteredProfiles.every((p) => p.pulse_enabled),
          )
        }
        noMatches={filteredProfiles.length === 0}
        emptyText={t("settings.pulse.noConnections")}
      >
        <PulseConnectionTree
          sections={sections}
          onToggle={(p) => void setEnabled([p.id], !p.pulse_enabled)}
          onToggleAll={(ids, enabled) => void setEnabled(ids, enabled)}
          sharedTooltip={sharedTooltip}
          searching={filter.trim().length > 0}
        />
      </ConnectionTreeCard>
    </div>
  );
}
