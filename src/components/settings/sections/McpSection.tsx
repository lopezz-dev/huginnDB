/**
 * MCP connector settings.
 *
 * Surfaces the bundled `huginndb-mcp` sidecar's on-disk path and generates
 * a ready-to-paste client config, so wiring up an AI tool doesn't require
 * hunting through the install directory or the source tree (see
 * `docs/MCP.md` and ADR #20). It never starts the server —
 * that is the AI client's job — but it does write the connector's per-connection
 * settings: exposure, write policy and row cap, plus the global row-cap default.
 *
 * The picker is a tree grouped by provenance, mirroring the connection manager's
 * rail (`McpConnectionTree`), because that is the distinction this panel turns on:
 * a connection a shared origin publishes keeps the **same id on every machine**,
 * so a snippet built from shared connections works for the whole team as-is,
 * while one built from a stale local copy works only here. Out of a flat list
 * those two are indistinguishable.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notify";
import { Copy, Terminal } from "lucide-react";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/tauri";
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
  selectConnectionPrefs,
} from "@/stores/preferences/preferences";
import {
  MAX_MCP_MAX_ROWS,
  MIN_MCP_MAX_ROWS,
  parseMcpMaxRows,
} from "@/lib/connection/mcpMaxRows";
import type {
  ClaudeCodeRegistration,
  ClaudeCodeStatus,
  ConnectionProfile,
  McpConnectorInfo,
  McpWritePolicy,
} from "@/types";

import { Badge } from "@/components/ui/badge";
import { ConnectionTreeCard } from "./ConnectionTreeCard";
import { PrefGroup } from "./PrefGroup";
import { PrefRow } from "./PrefRow";
import { McpConnectionTree } from "./McpConnectionTree";
import { WRITE_LEVELS } from "./McpWritePolicySelect";
import { copyToClipboard } from "@/lib/clipboard";

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      icon={Copy}
      onClick={() => {
        // Awaited, unlike the fire-and-forget version this replaced: now that
        // the write is a real IPC round trip to the OS clipboard, a failure is
        // detectable and the toast must not claim success ahead of it.
        void copyToClipboard(text).then(() =>
          notify.success(t("settings.mcp.copied")),
        );
      }}
    >
      {t("common.copy")}
    </Button>
  );
}

export function McpSection() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<McpConnectorInfo | null>(null);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<ProfileScope>("all");
  /** Pending "set everything to full", which is the one level worth a prompt. */
  const [pendingFull, setPendingFull] = useState(false);
  /**
   * In-flight state for the bulk policy row.
   *
   * Deliberately NOT `useAsyncSubmit`: that hook leaves `submitting` true after a
   * success, on the contract that the success path unmounts the dialog it is
   * driving (ADR #44). This row lives in a section that stays mounted, so the
   * flag never cleared and the three buttons stayed disabled until the user
   * navigated to another section and back. Clearing in a `finally` is right here
   * for the same reason it is wrong there — nothing unmounts to do it for us,
   * and re-applying the same policy twice is harmless.
   */
  const [applying, setApplying] = useState(false);
  /** Result of the last "add to Claude Code" click, or null before the first. */
  const [registration, setRegistration] =
    useState<ClaudeCodeRegistration | null>(null);
  const [registering, setRegistering] = useState(false);
  /**
   * What Claude Code has registered as `huginndb`, read when the section opens.
   * The point is the `stale` case: a registration made from an AppImage before
   * the AppImage fix points into a mount that no longer exists, and "Add" only
   * ever said it was already there.
   */
  const [claudeStatus, setClaudeStatus] = useState<ClaudeCodeStatus | null>(
    null,
  );
  const [bulkError, setBulkError] = useState<string | null>(null);
  const defaultMaxRows = usePreferences(selectConnectionPrefs).mcpMaxRows;
  const updateConnections = usePreferences((s) => s.updateConnections);

  useEffect(() => {
    void api
      .getMcpConnectorInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
    void api
      .listProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
    refreshClaudeStatus();
  }, []);

  function refreshClaudeStatus() {
    void api
      .getClaudeCodeRegistration()
      .then(setClaudeStatus)
      .catch(() => setClaudeStatus(null));
  }

  /**
   * The checked set is not local UI state: it *is* `ConnectionProfile.mcp_exposed`,
   * the field the sidecar reads to decide what it may reach at all.
   *
   * It used to be a `useState` that fed nothing but the generated snippet, so
   * this panel could offer the choice without being able to make it — the real
   * decision lived in the client's own config as `--connections <uuid>,<uuid>`,
   * which is why adding a connection meant hand-editing a JSON file per client
   * and restarting each one. Deriving it from the profiles keeps the checkbox
   * honest: what is ticked here is exactly what is reachable, and the sidecar
   * re-reads it per call, so it takes effect without a restart.
   */
  const selected = useMemo(
    () => new Set(profiles.filter((p) => p.mcp_exposed).map((p) => p.id)),
    [profiles],
  );

  const shared = useMemo(() => profiles.filter(isFromOrigin), [profiles]);
  const hasShared = shared.length > 0;

  // Removing the last origin must not leave the panel stuck on an empty
  // "Shared" — same reset the connection rail does.
  useEffect(() => {
    if (!hasShared && scope !== "all") setScope("all");
  }, [hasShared, scope]);

  /** What the list is showing: the provenance scope, then the name filter. */
  const filteredProfiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const inScope = filterByScope(profiles, scope);
    if (!q) return inScope;
    return inScope.filter((p) => p.name.toLowerCase().includes(q));
  }, [profiles, filter, scope]);

  // `buildRailSections` is reused rather than reimplemented so this panel and
  // the connection rail cannot drift on labels or ordering. Local and shared are
  // built separately and concatenated, because unlike the rail — which shows one
  // scope at a time — the All view here wants both headers: this is where the
  // difference between a portable id and a local-only one is acted on.
  const originsById = useOrigins((s) => s.byId);
  const sections = useMemo(() => {
    const nameOf = (id: string) => originsById[id]?.name ?? null;
    const labels = {
      shared: (origin: string) => t("connections.sharedSection", { origin }),
      orphaned: t("connections.orphanedSection"),
    };
    return [
      ...buildRailSections(filteredProfiles, "local", nameOf, labels).map(
        (section) => ({
          ...section,
          label: t("settings.mcp.localSection"),
        }),
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
   * Expose or hide one connection. Optimistic, then resynced from disk on
   * failure — the same shape as `setWritePolicy` below and for the same reason:
   * leaving a tick on screen that never landed would tell the user an AI client
   * can reach a database it cannot (or, worse, the reverse).
   */
  async function toggle(id: string) {
    const next = !selected.has(id);
    setProfiles((prev) =>
      prev.map((p) => (p.id === id ? { ...p, mcp_exposed: next } : p)),
    );
    try {
      await api.setMcpExposed([id], next);
    } catch {
      notify.error(t("settings.mcp.exposureSaveError"));
      void api
        .listProfiles()
        .then(setProfiles)
        .catch(() => {});
    }
  }

  /**
   * Persist one connection's MCP write policy. The sidecar re-reads it from
   * `profiles.json` on its next write attempt, so no client restart is needed.
   * On failure we resync from disk rather than leave optimistic state that never
   * actually landed.
   *
   * Goes through `setMcpWritePolicy` rather than `saveProfile`, even for a single
   * row: `save_profile` replaces the whole record, so it can only be called with
   * a complete profile in hand and silently erases anything the caller forgot to
   * carry over. This writes the one field it means to.
   */
  async function setWritePolicy(id: string, level: McpWritePolicy) {
    if (!profiles.some((p) => p.id === id)) return;
    setProfiles((prev) =>
      prev.map((p) => (p.id === id ? { ...p, mcp_write: level } : p)),
    );
    try {
      await api.setMcpWritePolicy([id], level);
      // The optimistic row update above is the *only* thing that moves, and it
      // moved before the write was accepted — so on screen a saved change and
      // an unsaved one look identical. This is also the app's write-permission
      // boundary for an agent that runs headless: worth one line saying the
      // server took it.
      notify.success(
        t("settings.mcp.writePolicySaved", {
          name: profiles.find((p) => p.id === id)?.name ?? id,
          level: t(`settings.mcp.level.${level}`),
        }),
      );
    } catch {
      notify.error(t("settings.mcp.writePolicySaveError"));
      void api
        .listProfiles()
        .then(setProfiles)
        .catch(() => {});
    }
  }

  /**
   * Persist one connection's MCP row cap, or clear it (`null`) so it follows
   * the default. Same shape and the same reasons as `setWritePolicy` above —
   * one field through its own command, optimistic, resynced on failure — and,
   * like it, picked up by the sidecar on its next call.
   */
  async function setMaxRows(id: string, rows: number | null) {
    const name = profiles.find((p) => p.id === id)?.name ?? id;
    setProfiles((prev) =>
      prev.map((p) => (p.id === id ? { ...p, mcp_max_rows: rows } : p)),
    );
    try {
      await api.setMcpMaxRows([id], rows);
      notify.success(
        rows == null
          ? t("settings.mcp.maxRows.clearedSaved", {
              name,
              rows: defaultMaxRows,
            })
          : t("settings.mcp.maxRows.saved", { name, rows }),
      );
    } catch {
      notify.error(t("settings.mcp.maxRows.saveError"));
      void api
        .listProfiles()
        .then(setProfiles)
        .catch(() => {});
    }
  }

  /**
   * Set every listed connection's policy in one backend write.
   *
   * "Listed" — scope plus name filter — rather than "selected": the selection
   * here means "expose these over MCP", a different question, and overloading it
   * would make one checkbox mean two things. The button carries the count so
   * what it will touch is never implicit.
   *
   * Runs over shared connections too. That is only honest because
   * `merge_profiles_bundle` preserves the policy across a sync; before it did,
   * this would have appeared to work and reverted on the next pull.
   */
  async function applyBulkPolicy(level: McpWritePolicy) {
    const ids = filteredProfiles.map((p) => p.id);
    if (ids.length === 0) return;
    setApplying(true);
    setBulkError(null);
    try {
      const changed = await api.setMcpWritePolicy(ids, level);
      setProfiles((prev) =>
        prev.map((p) => (ids.includes(p.id) ? { ...p, mcp_write: level } : p)),
      );
      setPendingFull(false);
      notify.success(
        changed > 0
          ? t("settings.mcp.bulkPolicyApplied", { count: changed })
          : t("settings.mcp.bulkPolicyNoop"),
      );
    } catch (e) {
      // Stays in the confirm dialog when there is one, and falls back to a toast
      // for the two levels that have none.
      setBulkError(String(e));
      if (!pendingFull) notify.error(String(e));
    } finally {
      setApplying(false);
    }
  }

  const allFilteredSelected =
    filteredProfiles.length > 0 &&
    filteredProfiles.every((p) => selected.has(p.id));

  /** Expose every id in the list, or hide them if all are already exposed.
   *  Drives both the toolbar button (every filtered profile) and each section
   *  header. One backend write for the batch, like the bulk policy row. */
  async function toggleAll(ids: string[]) {
    if (ids.length === 0) return;
    const next = !ids.every((id) => selected.has(id));
    const set = new Set(ids);
    setProfiles((prev) =>
      prev.map((p) => (set.has(p.id) ? { ...p, mcp_exposed: next } : p)),
    );
    try {
      await api.setMcpExposed(ids, next);
    } catch {
      notify.error(t("settings.mcp.exposureSaveError"));
      void api
        .listProfiles()
        .then(setProfiles)
        .catch(() => {});
    }
  }

  /**
   * Run the `claude mcp add` the snippet below spells out, so the common case
   * is a click rather than a trip to a terminal.
   *
   * Every outcome is a value, not an exception: "already registered" is what a
   * second click looks like, and "no CLI on PATH" is a perfectly ordinary state
   * for someone who only uses Claude Desktop. Both leave the copyable command
   * right there as the fallback.
   */
  async function addToClaudeCode() {
    await runRegistration(api.registerWithClaudeCode);
  }

  /** Replace a stale registration — the button only the `stale` notice shows. */
  async function updateClaudeCode() {
    await runRegistration(api.updateClaudeCodeRegistration);
  }

  async function runRegistration(run: () => Promise<ClaudeCodeRegistration>) {
    setRegistering(true);
    try {
      setRegistration(await run());
    } catch (e) {
      setRegistration({ outcome: "failed", detail: String(e) });
    } finally {
      setRegistering(false);
      refreshClaudeStatus();
    }
  }

  const path = info?.binary_path ?? "";
  // `["--mcp"]` when the app runs from an AppImage: the command is then the
  // image file, whose path survives a restart, rather than the sidecar inside
  // its per-launch `/tmp/.mount_*` (see `mcp_launcher.rs`). Empty otherwise.
  const args = info?.args ?? [];
  const command = [path, ...args].join(" ");
  // No `--connections` and no uuids: the exposed set is the checkboxes above,
  // read from `profiles.json` on every call. That is what makes the snippet
  // paste-once — adding a connection later is a tick here, not an edit of every
  // client's config followed by a restart of each. (The flag still exists for
  // pinning one client to a fixed subset; `docs/MCP.md` covers it.)
  const cliCommand = path ? `claude mcp add huginndb -s user -- ${command}` : "";
  const jsonSnippet = path
    ? JSON.stringify(
        {
          mcpServers: {
            huginndb: args.length ? { command: path, args } : { command: path },
          },
        },
        null,
        2,
      )
    : "";

  return (
    <div className="space-y-5 text-sm">
      <p className="text-xs text-muted-foreground">{t("settings.mcp.intro")}</p>

      <PrefGroup
        title={t("settings.mcp.binaryLabel")}
        action={
          info?.available ? (
            <Badge tone="success" size="xs">
              {t("settings.mcp.available")}
            </Badge>
          ) : (
            <Badge tone="warning" size="xs">
              {t("settings.mcp.unavailable")}
            </Badge>
          )
        }
        padded
      >
        <div className="flex items-center justify-between gap-2">
          <code className="break-all rounded-sm bg-muted px-1.5 py-0.5 font-mono text-2xs">
            {command || "—"}
          </code>
          {path && <CopyButton text={command} />}
        </div>
        {args.length > 0 && (
          <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">
            {t("settings.mcp.appImageHint")}
          </p>
        )}
      </PrefGroup>

      <ConnectionTreeCard
        title={t("settings.mcp.connectionsLabel")}
        count={t("settings.mcp.selectedCount", {
          selected: selected.size,
          total: profiles.length,
        })}
        total={profiles.length}
        sharedCount={shared.length}
        scope={scope}
        onScopeChange={setScope}
        filter={filter}
        onFilterChange={setFilter}
        bulkLabel={
          allFilteredSelected
            ? t("settings.mcp.deselectAll")
            : t("settings.mcp.selectAll")
        }
        onBulk={() => void toggleAll(filteredProfiles.map((p) => p.id))}
        noMatches={filteredProfiles.length === 0}
        emptyText={t("settings.mcp.noConnections")}
        footer={
          <>
            {/* Bulk policy. Acts on what is listed, not on what is checked —
                the checkboxes answer "expose this over MCP", which is a
                different question. `full` is the only level that can change
                schema, so it is the only one that asks first. */}
            {filteredProfiles.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-2xs text-muted-foreground">
                  {t("settings.mcp.bulkPolicyLabel")}
                </span>
                {WRITE_LEVELS.map((lvl) => (
                  <Button
                    key={lvl}
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={applying}
                    onClick={() =>
                      lvl === "full"
                        ? setPendingFull(true)
                        : void applyBulkPolicy(lvl)
                    }
                  >
                    {t(`settings.mcp.level.${lvl}`)}
                  </Button>
                ))}
                <span className="text-2xs text-muted-foreground/60">
                  ({filteredProfiles.length})
                </span>
              </div>
            )}
            <p className="text-2xs leading-relaxed text-muted-foreground">
              {t("settings.mcp.writePolicyHint")}
            </p>
            <p className="text-2xs leading-relaxed text-muted-foreground">
              {t("settings.mcp.maxRows.hint")}
            </p>
            <p className="text-2xs leading-relaxed text-muted-foreground">
              {t("settings.mcp.sharedIdsHint")}
            </p>
            {/* The snippet below is valid whether or not anything is ticked, so
                nothing else would tell the user their connector will come up
                unable to reach a single database. */}
            {selected.size === 0 && (
              <p className="text-2xs leading-relaxed text-warning">
                {t("settings.mcp.nothingExposedHint")}
              </p>
            )}
          </>
        }
      >
        <McpConnectionTree
          sections={sections}
          selected={selected}
          onToggle={(id) => void toggle(id)}
          onToggleAll={(ids) => void toggleAll(ids)}
          onSetPolicy={(id, level) => void setWritePolicy(id, level)}
          onSetMaxRows={(id, rows) => void setMaxRows(id, rows)}
          defaultMaxRows={defaultMaxRows}
          sharedTooltip={sharedTooltip}
          searching={filter.trim().length > 0}
        />
      </ConnectionTreeCard>

      <PrefGroup title={t("settings.mcp.limitsLabel")}>
        <PrefRow
          label={t("settings.mcp.maxRows.label")}
          prefId="connections.mcpMaxRows"
          description={t("settings.mcp.maxRows.desc")}
          htmlFor="prefs-mcp-max-rows"
        >
          <Input
            id="prefs-mcp-max-rows"
            type="number"
            min={MIN_MCP_MAX_ROWS}
            max={MAX_MCP_MAX_ROWS}
            step={50}
            value={defaultMaxRows}
            onChange={(e) => {
              const rows = parseMcpMaxRows(e.target.value);
              if (rows != null) updateConnections({ mcpMaxRows: rows });
            }}
            className="h-8 w-24 text-right font-mono text-xs"
          />
        </PrefRow>
      </PrefGroup>

      <PrefGroup
        title={t("settings.mcp.claudeCodeLabel")}
        action={
          <>
            {path && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                icon={Terminal}
                disabled={registering}
                onClick={() => void addToClaudeCode()}
              >
                {registering
                  ? t("settings.mcp.addingToClaudeCode")
                  : t("settings.mcp.addToClaudeCode")}
              </Button>
            )}
            {cliCommand && <CopyButton text={cliCommand} />}
          </>
        }
        padded
      >
        {claudeStatus?.state === "stale" && (
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-2xs leading-relaxed text-warning">
              {t(
                claudeStatus.gone
                  ? "settings.mcp.claudeStatus.staleGone"
                  : "settings.mcp.claudeStatus.stale",
              )}{" "}
              <code className="break-all font-mono">
                {claudeStatus.registered}
              </code>
            </p>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={registering}
              onClick={() => void updateClaudeCode()}
            >
              {registering
                ? t("settings.mcp.claudeStatus.updating")
                : t("settings.mcp.claudeStatus.update")}
            </Button>
          </div>
        )}
        {claudeStatus?.state === "custom" && (
          <p className="mb-2 text-2xs leading-relaxed text-muted-foreground">
            {t("settings.mcp.claudeStatus.custom")}{" "}
            <code className="break-all font-mono">
              {claudeStatus.registered}
            </code>
          </p>
        )}
        {claudeStatus?.state === "current" && !registration && (
          <p className="mb-2 text-2xs leading-relaxed text-muted-foreground">
            {t("settings.mcp.claudeStatus.current")}
          </p>
        )}
        {registration && (
          <p
            className={
              registration.outcome === "failed"
                ? "text-2xs leading-relaxed text-destructive"
                : "text-2xs leading-relaxed text-muted-foreground"
            }
          >
            {t(`settings.mcp.register.${registration.outcome}`)}
            {registration.outcome === "failed" && registration.detail
              ? ` ${registration.detail}`
              : ""}
          </p>
        )}
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/60 p-2 font-mono text-2xs">
          {cliCommand || t("settings.mcp.noBinaryHint")}
        </pre>
      </PrefGroup>

      <PrefGroup
        title={t("settings.mcp.jsonLabel")}
        action={jsonSnippet ? <CopyButton text={jsonSnippet} /> : undefined}
        padded
      >
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/60 p-2 font-mono text-2xs">
          {jsonSnippet || t("settings.mcp.noBinaryHint")}
        </pre>
      </PrefGroup>

      {pendingFull && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setPendingFull(false);
              setBulkError(null);
            }
          }}
          title={t("settings.mcp.bulkPolicyFullTitle", {
            count: filteredProfiles.length,
          })}
          description={t("settings.mcp.bulkPolicyFullBody")}
          confirmLabel={t("settings.mcp.bulkPolicyFullConfirm", {
            count: filteredProfiles.length,
          })}
          confirming={applying}
          error={bulkError}
          onConfirm={() => void applyBulkPolicy("full")}
        />
      )}
    </div>
  );
}
