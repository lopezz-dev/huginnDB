/**
 * Connections manager — master/detail.
 *
 * Mirrors the preferences dialog layout: a left rail lists every saved
 * connection (with a live "connected" dot) plus a "New connection" entry;
 * the right pane edits the selected profile via the General / SSH-tunnel
 * tabs. The form reshapes itself per driver: SQLite hides the network
 * fields and asks only for a database file path.
 *
 * Passwords are submitted to the backend separately from profile metadata
 * so `api.saveProfile(profile, password, sshSecret)` can route them to the
 * OS keychain — DB password under one account, SSH secret under another.
 *
 * Actions live in the right-pane footer: Test, Connect (save + open the
 * pool), Delete, and Save. `onConnected` lets the caller (the sidebar)
 * focus the connection in the main view once it opens.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  Check,
  Copy,
  Database,
  Download,
  Folder,
  Plug,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DEFAULT_PORTS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/common/PasswordInput";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ExportProfilesDialog } from "@/components/connection/dialogs/ExportProfilesDialog";
import { ImportProfilesDialog } from "@/components/connection/dialogs/ImportProfilesDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DriverBadge, driverLabel } from "@/components/common/DriverBadge";
import { ConnectionRail } from "@/components/connection/ConnectionRail";
import {
  useConnectionForm,
  type SshAuthMethod,
} from "@/lib/connection/useConnectionForm";
import { api } from "@/lib/tauri";
import { DeleteConnectionsDialog } from "@/components/connection/dialogs/DeleteConnectionsDialog";
import { MongoUriFoldDialog } from "@/components/connection/dialogs/MongoUriFoldDialog";
import { isFromOrigin } from "@/lib/connection/origin";
import { originScope } from "@/lib/origins/scope";
import { PersonalCredentialsNotice } from "@/components/connection/PersonalCredentialsNotice";
import { SecretOverrideNotice } from "@/components/connection/SecretOverrideNotice";
import { notify } from "@/lib/notify";
import { useConnectionDialog } from "@/stores/dialogs/connectionDialog";
import { useOriginEditor } from "@/stores/dialogs/originEditor";
import { useOriginRepublish } from "@/stores/dialogs/originRepublish";
import { useOriginName, useOrigins } from "@/stores/sync/origins";
import type {
  ConnectionProfile,
  Driver,
  HostKeyPolicy,
  MsSqlAuth,
} from "@/types";
import { useConnections } from "@/stores/session/connections";
import {
  selectConnectionPrefs,
  usePreferences,
} from "@/stores/preferences/preferences";
import { useSchema } from "@/stores/session/schema";
import { isWindows } from "@/lib/platform";
import { driverMismatchHint, supportsSshTunnel } from "@/lib/db/driver";
import { copyToClipboard } from "@/lib/clipboard";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Profile to pre-select on open. `null`/absent opens a fresh draft. */
  initial?: ConnectionProfile | null;
  /** Called after a successful Connect so the caller can focus the pool. */
  onConnected?: (id: string) => void;
}

/**
 * Structured status for the action footer. Keeping the kind discrete avoids
 * fragile `.startsWith()` checks against localised strings when picking the
 * status colour.
 */
type TestStatus =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "saved" }
  | { kind: "error"; message: string }
  | { kind: "saveError"; message: string };

export function ConnectionDialog({
  open,
  onOpenChange,
  initial,
  onConnected,
}: Props) {
  const { t } = useTranslation();
  const connectionPrefs = usePreferences(selectConnectionPrefs);
  const save = useConnections((s) => s.save);
  const connect = useConnections((s) => s.connect);
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const refreshSchema = useSchema((s) => s.refresh);

  /** Windows-only auth modes are hidden elsewhere — the backend refuses them
   *  on other platforms because the driver's NTLM support is `cfg(windows)`. */
  const onWindows = isWindows();

  // Every editable field, plus the rules that relate them — see the hook for
  // why the form model is separate from this dialog's flow.
  const {
    name,
    setName,
    group,
    setGroup,
    driver,
    onDriverChange,
    host,
    setHost,
    port,
    setPort,
    database,
    setDatabase,
    username,
    setUsername,
    password,
    setPassword,
    ssl,
    setSsl,
    maxConnections,
    operationTimeout,
    setOperationTimeout,
    setMaxConnections,
    setConnectionString,
    authSource,
    setAuthSource,
    mongoDirectConnection,
    setMongoDirectConnection,
    mongoUriManual,
    onToggleMongoUriManual,
    mongoFoldConflict,
    confirmMongoUriFold,
    cancelMongoUriFold,
    effectiveMongoUri,
    isMongoSrv,
    mssqlInstance,
    setMssqlInstance,
    mssqlTrustCert,
    setMssqlTrustCert,
    mssqlAuth,
    setMssqlAuth,
    normalizeServerName,
    sshEnabled,
    setSshEnabled,
    sshHost,
    setSshHost,
    sshPort,
    setSshPort,
    sshUsername,
    setSshUsername,
    sshAuthMethod,
    setSshAuthMethod,
    sshKeyPath,
    setSshKeyPath,
    sshSecret,
    setSshSecret,
    sshLocalPort,
    setSshLocalPort,
    sshHostKeyPolicy,
    setSshHostKeyPolicy,
    trustedFingerprint,
    setTrustedFingerprint,
    buildSshTunnel,
    loadFields,
  } = useConnectionForm(open);

  /** Which profile is open in the editor; `null` means a new draft. */
  const [editingId, setEditingId] = useState<string | null>(
    initial?.id ?? null,
  );

  /** A profile queued by "Duplicate" to load as a fresh draft on the next
   *  editingId change (see the load effect). */
  const pendingCloneRef = useRef<ConnectionProfile | null>(null);
  /** Shows the "password isn't copied" banner after a duplicate (#38). */
  const [duplicateHint, setDuplicateHint] = useState(false);

  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: "idle" });
  /** Transient "copied" feedback on the error-box copy button. */
  const [errorCopied, setErrorCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  /** Profiles queued for deletion. Non-empty is what mounts the confirmation —
   *  see `DeleteConnectionsDialog` for why it has no `open` prop. */
  const [deleteTargets, setDeleteTargets] = useState<ConnectionProfile[]>([]);

  /**
   * Stable id for the profile being edited. For existing profiles this is
   * just the profile id; for new ones we pre-mint a UUID so that both Test
   * and Save key keychain entries (DB password + SSH secret) under the same
   * `${id}::…` account.
   */
  const [draftId, setDraftId] = useState<string>("");

  // When the dialog opens, select whatever the caller asked for. The rail's own
  // transient state (search term, multi-selection, range anchor) needs no reset
  // here: Radix unmounts `DialogContent` on close, so the rail remounts with
  // its initial state every time the manager is opened.
  useEffect(() => {
    if (!open) return;
    setEditingId(initial?.id ?? null);
  }, [open, initial]);

  // Tell the store which profile is on screen, so a full-screen editor opened
  // from here (the origin editor) can put the manager aside and bring it back
  // on this profile rather than the one it was opened on (gotcha #101).
  const reportFocus = useConnectionDialog((s) => s.focus);
  useEffect(() => {
    if (open) reportFocus(editingId);
  }, [open, editingId, reportFocus]);

  // Load the editor whenever the selection changes. We read the profile list
  // imperatively (rather than depending on `profiles`) so that a save/delete
  // that mutates the list does NOT wipe in-progress edits — the form only
  // reloads when the *selection* changes.
  useEffect(() => {
    if (!open) return;
    const list = useConnections.getState().profiles;
    // A pending clone (from "Duplicate") is loaded as a fresh draft: no
    // editingId, a brand-new draftId, and the password field left blank.
    const clone = !editingId ? pendingCloneRef.current : null;
    pendingCloneRef.current = null;
    const p = editingId
      ? (list.find((x) => x.id === editingId) ?? null)
      : clone;
    setDraftId(editingId && p ? p.id : crypto.randomUUID());
    loadFields(p);
    setTestStatus({ kind: "idle" });
    setDuplicateHint(!!clone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingId]);

  /** Distinct group names already in use, for the datalist suggestion below
   *  the Group field — a soft nudge toward reusing an existing name instead
   *  of a near-duplicate (free text, so nothing enforces this). */
  const existingGroups = useMemo(() => {
    const names = new Set<string>();
    for (const p of profiles) if (p.group) names.add(p.group);
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [profiles]);

  /**
   * Whether the profile under edit came from a shared origin (#108). Read from
   * the stored profile rather than from form state: the form is a draft, and a
   * draft can't be trusted to still carry `origin_id`.
   */
  const stored = editingId ? profiles.find((p) => p.id === editingId) : null;
  const fromOrigin = isFromOrigin(stored);
  /** Name of the publishing origin, for the banner. `null` when the origin has
   *  been unregistered — the profile stays read-only (the tag is what gates
   *  that), so the banner falls back to the unnamed copy rather than lying. */
  const originName = useOriginName(stored?.origin_id);
  /**
   * Whether this machine publishes the origin behind this profile — in which
   * case the read-only banner can offer the way *out* of it instead of just
   * explaining the dead end. Read from the registry rather than from the
   * profile, because the role is a property of this machine's registration and
   * not of anything the file says.
   */
  const originIsPublished = useOrigins((s) =>
    stored?.origin_id ? s.byId[stored.origin_id]?.role === "publisher" : false,
  );
  /**
   * The one exception to `fromOrigin`'s read-only rule: the machine that
   * publishes this profile's origin may correct it in place — save writes
   * local `profiles.json` + this machine's own keychain (`save_profile` has
   * no `origin_id` guard at all; only the frontend ever enforced read-only),
   * exactly what the origin editor's `fromKeychain` secret mode resolves from
   * at the next publish. Still `origin_id`-linked afterwards: this is a
   * correction, not a detach — `adopt`/`onDuplicate` stay the way to make an
   * independent local copy.
   */
  const canEditInPlace = fromOrigin && originIsPublished;
  /** Whether the person signs in to it with their own database user —
   *  reported by `PersonalCredentialsNotice`, which asks the backend. */
  const [personalActive, setPersonalActive] = useState(false);
  /**
   * Whether the origin behind this profile has stopped pulling connections
   * (#171), in which case this entry is still the file's — tagged, read-only,
   * not deletable — but will never be refreshed again.
   *
   * Said out loud because the state is otherwise unreadable: "you cannot edit
   * this, it comes from a shared file" is an explanation the user can act on,
   * and it silently becomes false the moment the slice is switched off. The
   * way out is unchanged (duplicate it, or release it from Settings), so this
   * adds a sentence rather than a new control.
   */
  const originStoppedPulling = useOrigins((s) => {
    const origin = stored?.origin_id ? s.byId[stored.origin_id] : null;
    return origin ? !originScope(origin).connections : false;
  });
  const openOriginEditor = useOriginEditor((state) => state.open);
  const askToRepublish = useOriginRepublish((state) => state.open);

  /**
   * Offer to send a publisher's local correction on to the share.
   *
   * Called after the save, never instead of it: `save_profile` fixing this
   * machine is the thing the user asked for, and publishing is a second,
   * outward-facing action that gets its own yes. Before this the two were
   * separated by a trip through Settings → the origin editor → find the row →
   * flip its secret → publish, which is a long way to go to say the same thing
   * twice, and every consumer stayed broken for the length of it.
   *
   * `withSecret` is read from the password field *as it was when the save ran*
   * — the reload the save triggers clears it — and it is what decides whether
   * the republish re-encrypts at all (gotcha #56).
   */
  function offerRepublish(profileId: string, secretChanged: boolean) {
    if (!canEditInPlace || !stored?.origin_id) return;
    askToRepublish({
      originId: stored.origin_id,
      originName: originName ?? "",
      profileId,
      profileName: name || stored.name,
      withSecret: secretChanged,
    });
  }

  function buildProfile(): ConnectionProfile {
    // Start from the stored profile so fields this form doesn't edit survive a
    // save. `save_profile` replaces the whole record, so anything omitted here
    // is *erased* — which silently reset `mcp_write` to read-only and dropped
    // `visible_databases` every time a connection was edited. Spreading first
    // and overriding below fixes that for the existing fields as well as for
    // `max_connections`.
    const parsedMax = Number.parseInt(maxConnections, 10);
    const parsedTimeout = Number.parseInt(operationTimeout, 10);
    return {
      ...(stored ?? undefined),
      id: editingId ?? draftId,
      name,
      group: group.trim() || null,
      driver,
      host,
      port,
      database,
      username,
      ssl,
      ssh_tunnel: buildSshTunnel(),
      connection_string:
        driver === "mongodb" ? effectiveMongoUri.trim() || null : null,
      // Persisted explicitly for the URI-less CLI path and form repopulation.
      // In raw-edit mode the authSource lives inside the pasted URI instead.
      auth_source:
        driver === "mongodb" && !mongoUriManual
          ? authSource.trim() || null
          : null,
      max_connections:
        Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : null,
      operation_timeout_secs:
        Number.isFinite(parsedTimeout) && parsedTimeout > 0
          ? parsedTimeout
          : null,
      mssql:
        driver === "sqlserver"
          ? {
              instance: mssqlInstance.trim() || null,
              trust_server_certificate: mssqlTrustCert,
              auth: mssqlAuth,
            }
          : null,
    };
  }

  async function onTest() {
    setTestStatus({ kind: "testing" });
    try {
      await api.testConnection(
        buildProfile(),
        password || undefined,
        sshSecret || undefined,
      );
      setTestStatus({ kind: "ok" });
    } catch (e) {
      setTestStatus({ kind: "error", message: String(e) });
    }
  }

  async function onSave() {
    // A profile published by a shared origin is a mirror of somebody else's
    // entry: the next sync overwrites whatever is changed here, so allowing the
    // edit would silently discard the user's work. Enforced at the boundary and
    // not only by disabling the form, because Enter-to-save and any future call
    // site would otherwise slip past the UI guard (`origin_id`'s contract in
    // `state.rs` says read-only; until now only the docs said so). The one
    // exception is `canEditInPlace`: this machine publishes the origin, so a
    // correction here is exactly what the next publish is meant to pick up.
    if (fromOrigin && !canEditInPlace) return;
    setSaving(true);
    // Read before the save: `setEditingId` below reloads the form, which
    // clears both secret fields.
    const secretChanged = !!password || !!sshSecret;
    try {
      const saved = await save(
        buildProfile(),
        password || undefined,
        sshSecret || undefined,
      );
      // Stay on the saved profile (clears the secret fields via reload when
      // this was a new draft); keep the dialog open so the user can manage
      // other connections.
      setEditingId(saved.id);
      setTestStatus({ kind: "saved" });
      offerRepublish(saved.id, secretChanged);
    } catch (e) {
      setTestStatus({ kind: "saveError", message: String(e) });
    } finally {
      setSaving(false);
    }
  }

  async function onConnect() {
    setConnecting(true);
    setTestStatus({ kind: "idle" });
    // Same reason as `onSave`, one step further along: connecting saves *and*
    // closes the dialog, so this is read before either happens.
    const secretChanged = !!password || !!sshSecret;
    const wasSaving = !(fromOrigin && !canEditInPlace);
    try {
      // Persist any edits + credentials first so the pool opens against the
      // saved profile and the keychain has the secret it needs. A read-only
      // origin-linked profile (and not `canEditInPlace`) skips this — the
      // fields aren't individually disabled (only Save/Connect are gated), so
      // whatever the user typed here must never reach `save_profile`, the
      // same boundary `onSave` enforces.
      const id =
        fromOrigin && !canEditInPlace
          ? stored!.id
          : (
              await save(
                buildProfile(),
                password || undefined,
                sshSecret || undefined,
              )
            ).id;
      // `connect` reuses a pool that is already open, and after an edit that
      // pool still points at the old database, host or user. Pressing Connect
      // here is an explicit ask for the settings on screen, so close it first
      // — everywhere, since the pool is shared; the other windows see the
      // ordinary connection-closed event.
      if ((await api.editedConnections()).includes(id)) {
        await useConnections.getState().disconnect(id);
      }
      await connect(id, password || undefined);
      await refreshSchema(id);
      setEditingId(id);
      onConnected?.(id);
      onOpenChange(false);
      // "Fix the password, connect, done" is the flow a rotated credential
      // actually produces — the publisher never goes back to press Save. The
      // prompt lives in its own store precisely so it survives the line above.
      if (wasSaving) offerRepublish(id, secretChanged);
    } catch (e) {
      const err = String(e);
      const hint = driverMismatchHint(err);
      setTestStatus({
        kind: "error",
        message: hint ? `${err} — ${hint}` : err,
      });
    } finally {
      setConnecting(false);
    }
  }

  function onDelete() {
    if (!editingId || !stored) return;
    // Deleting an origin-published profile locally is pointless — the next sync
    // re-imports it — and destroys its keychain entry on the way. Retiring one
    // for good is offered where it makes sense: on the notice raised when the
    // origin itself stops publishing it (`useOriginSync.retire`).
    if (fromOrigin) return;
    setDeleteTargets([stored]);
  }

  /** Duplicate the profile currently in the editor (#38). Clones every
   *  metadata field into a fresh draft with a uniquified name; the password is
   *  deliberately NOT copied (the keychain is keyed by profile id, and a clone
   *  gets a new id), so the user re-enters it — the banner flags this. */
  function onDuplicate() {
    if (!editingId) return;
    const base = buildProfile();
    const existing = new Set(profiles.map((p) => p.name));
    const copy = t("connectionDialog.duplicateSuffix");
    let candidate = `${base.name} (${copy})`;
    for (let n = 2; existing.has(candidate); n++) {
      candidate = `${base.name} (${copy} ${n})`;
    }
    pendingCloneRef.current = { ...base, id: "", name: candidate };
    // Flip to a new draft; the load effect picks up the pending clone. The rail
    // drops its selection off the same signal (see its `editingId` effect).
    setEditingId(null);
  }

  /**
   * Accept SSMS's single-box `HOST\INSTANCE` in either field and split it in
   * place on blur.
   *
   * SSMS has one "Server name" input, so that is the form users know; typed
   * into our host field the backslash broke DNS resolution, and typed into the
   * instance field it was sent to the SQL Browser, which only ever answers to
   * the bare instance name. The backend normalises this too (`split_instance`,
   * the authoritative copy — it also covers the CLI and the MCP connector);
   * doing it here as well is so the user *sees* the split before saving rather
   * than having it happen silently.
   */
  async function onForgetHostKey() {
    if (!sshHost) return;
    const hostPort = `${sshHost}:${sshPort}`;
    if (!confirm(t("connectionDialog.ssh.forgetConfirm", { hostPort }))) return;
    try {
      const removed = await api.forgetHostKey(hostPort);
      alert(
        removed
          ? t("connectionDialog.ssh.forgetDone")
          : t("connectionDialog.ssh.forgetNone"),
      );
      setTrustedFingerprint(null);
    } catch (e) {
      alert(String(e));
    }
  }

  async function onPickKeyFile() {
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        title: t("connectionDialog.ssh.privateKeyPath"),
      });
      if (typeof picked === "string" && picked) setSshKeyPath(picked);
    } catch {
      // File dialog cancellation throws — ignore silently.
    }
  }

  const statusText = (() => {
    switch (testStatus.kind) {
      case "testing":
        return t("connectionDialog.testing");
      case "ok":
        return t("connectionDialog.testOk");
      case "saved":
        return t("connectionDialog.saved");
      case "error":
        return t("connectionDialog.testFailed", {
          message: testStatus.message,
        });
      case "saveError":
        return t("connectionDialog.saveFailed", {
          message: testStatus.message,
        });
      default:
        return null;
    }
  })();

  const statusClass = (() => {
    switch (testStatus.kind) {
      case "ok":
      case "saved":
        return "text-success";
      case "testing":
        return "text-muted-foreground";
      case "error":
      case "saveError":
        return "text-destructive";
      default:
        return "";
    }
  })();

  /** `error` and `saveError` carry a (potentially long) backend message that
   *  gets its own wrapping, scrollable box; the short states stay one-line. */
  const isErrorStatus =
    testStatus.kind === "error" || testStatus.kind === "saveError";

  async function onCopyError() {
    if (testStatus.kind !== "error" && testStatus.kind !== "saveError") return;
    // The "Copied" state waits for the write, same reason as the other two
    // optimistic confirmations this replaced.
    await copyToClipboard(testStatus.message);
    setErrorCopied(true);
    window.setTimeout(() => setErrorCopied(false), 1500);
  }

  const tunnelTabDisabled = !supportsSshTunnel(driver) || isMongoSrv;
  const busy = saving || connecting;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent tier="workbench" className="flex h-[85vh] max-w-6xl flex-col">
          <DialogHeader>
            <div className="flex items-center justify-between gap-2">
              <DialogTitle className="flex items-center gap-2 text-base">
                <Database className="h-4 w-4 text-primary" />
                {t("connectionDialog.managerTitle")}
              </DialogTitle>
              {/* `mr-2` clears the header's own `pr-10` close-button gap
                (set by the `workbench` tier) so the import/export actions
                don't sit under the X. */}
              <div className="mr-2 flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => setImportOpen(true)}
                    >
                      <Upload className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t("transfer.import.tooltip")}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => setExportOpen(true)}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t("transfer.export.tooltip")}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
            <DialogDescription className="text-2xs">
              {t("connectionDialog.managerDescription")}
            </DialogDescription>
          </DialogHeader>

          {/* The rail is 320px, not the 240px it started at: the provenance filter
            put a three-segment control above a list whose rows already carry a
            name, a driver badge and a shared-origin mark, and at 240 the names
            truncated mid-word. The dialog widened with it (4xl → 6xl) so the
            editor beside it did not pay for the space. */}
          <DialogBody className="grid grid-cols-[320px_1fr]">
            <ConnectionRail
              profiles={profiles}
              active={active}
              editingId={editingId}
              onEdit={setEditingId}
              onDeleteRequest={setDeleteTargets}
            />

            {/* Right pane — editor */}
            <main className="flex min-h-0 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {duplicateHint && (
                  <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1">
                      {t("connectionDialog.duplicatePasswordHint")}
                    </span>
                    {/* `-my-1`: the 24px square would otherwise make a
                        one-line notice taller than its text. */}
                    <IconButton
                      type="button"
                      flat
                      size="xs"
                      icon={X}
                      label={t("common.clear")}
                      onClick={() => setDuplicateHint(false)}
                      className="-my-1 shrink-0"
                    />
                  </div>
                )}
                <Tabs defaultValue="general" className="w-full">
                  <TabsList className="w-full">
                    <TabsTrigger value="general" className="flex-1">
                      {t("connectionDialog.tabs.general")}
                    </TabsTrigger>
                    <TabsTrigger
                      value="ssh"
                      className="flex-1"
                      disabled={tunnelTabDisabled}
                    >
                      {t("connectionDialog.tabs.ssh")}
                    </TabsTrigger>
                  </TabsList>

                  {/* Explains the form's state before the user discovers it by
                    typing into a field and finding Save greyed out (a plain
                    consumer) or wonders why editing is even allowed (the
                    publisher). Placed at the top of the first tab rather than
                    beside the button, since it's the editing that's affected,
                    not just the saving. */}
                  {fromOrigin && (
                    <div className="mb-2 rounded-md border border-border bg-muted/40 px-2.5 py-2 text-2xs text-muted-foreground">
                      {canEditInPlace
                        ? t("connectionDialog.fromOriginEditable", {
                            origin: originName ?? "",
                          })
                        : originName
                          ? t("connectionDialog.fromOriginNamed", {
                              origin: originName,
                            })
                          : t("connectionDialog.fromOrigin")}
                      {originStoppedPulling && (
                        <p className="mt-1">
                          {t("connectionDialog.fromOriginNotPulled")}
                        </p>
                      )}
                      {/* Only for an origin this machine publishes: pointing a
                        consumer at an editor that will open read-only is worse
                        than saying nothing. `canEditInPlace` already covers
                        every case this could show for, since it implies
                        `originIsPublished`. Opening the editor puts this
                        manager aside, and closing it reopens the manager on
                        this profile (`useOriginEditor`, gotcha #101). */}
                      {canEditInPlace && stored?.origin_id && (
                        <Button
                          type="button"
                          variant="link"
                          size="xs"
                          className="ml-1 h-auto p-0 text-2xs"
                          onClick={() => openOriginEditor(stored.origin_id!)}
                        >
                          {t("connectionDialog.editAtOrigin")}
                        </Button>
                      )}
                      {/* The consumer's way out of a password the publisher
                        has not fixed yet. Not offered to a publisher: they can
                        correct the connection properly, and republish it. */}
                      {!canEditInPlace && stored && (
                        <PersonalCredentialsNotice
                          profile={stored}
                          password={password}
                          onChange={setPersonalActive}
                        />
                      )}
                      {/* About the published user's password, so not while
                        the person signs in as their own user. */}
                      {!canEditInPlace && stored && !personalActive && (
                        <SecretOverrideNotice
                          profile={stored}
                          password={password}
                          sshSecret={sshSecret}
                        />
                      )}
                    </div>
                  )}
                  {/* A connection of one's own, whose user the policy pins:
                    said here, since there is no origin banner to say it in.
                    Renders nothing unless the policy pins one. */}
                  {!fromOrigin && stored && (
                    <div className="mb-2 rounded-md border border-border bg-muted/40 px-2.5 py-2 text-2xs text-muted-foreground empty:hidden">
                      <PersonalCredentialsNotice
                        profile={stored}
                        password={password}
                        bare
                      />
                    </div>
                  )}
                  <TabsContent value="general" className="pt-3">
                    <div className="grid gap-3">
                      <Field label={t("connectionDialog.fields.name")}>
                        <Input
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder={t(
                            "connectionDialog.fields.namePlaceholder",
                          )}
                        />
                      </Field>
                      <Field label={t("connectionDialog.fields.group")}>
                        <GroupCombobox
                          value={group}
                          onChange={setGroup}
                          suggestions={existingGroups}
                          placeholder={t(
                            "connectionDialog.fields.groupPlaceholder",
                          )}
                        />
                      </Field>
                      <Field label={t("connectionDialog.fields.driver")}>
                        <Select
                          value={driver}
                          onValueChange={(v) => onDriverChange(v as Driver)}
                        >
                          <SelectTrigger>
                            {/* Controlled value, so render the brand logo + label
                              directly rather than via <SelectValue>. */}
                            <span className="flex items-center gap-2">
                              <DriverBadge driver={driver} />
                              {driverLabel(driver)}
                            </span>
                          </SelectTrigger>
                          <SelectContent>
                            {(
                              [
                                "postgres",
                                "mysql",
                                "sqlite",
                                "mongodb",
                                "sqlserver",
                              ] as const
                            ).map((d) => (
                              <SelectItem key={d} value={d}>
                                <span className="flex items-center gap-2">
                                  <DriverBadge driver={d} />
                                  {driverLabel(d)}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      {driver === "mongodb" ? (
                        <>
                          {/* Form-primary fields (Compass-style). Disabled while
                            the connection string is hand-edited below. */}
                          <div className="grid grid-cols-3 gap-2">
                            <div className="col-span-2">
                              <Field label={t("connectionDialog.fields.host")}>
                                <Input
                                  value={host}
                                  disabled={mongoUriManual}
                                  onChange={(e) => setHost(e.target.value)}
                                />
                              </Field>
                            </div>
                            <Field label={t("connectionDialog.fields.port")}>
                              <Input
                                type="number"
                                value={port || ""}
                                // Blank is a real choice, not an unfinished
                                // field: it stores 0, which both sides read as
                                // "this driver's default". The placeholder is
                                // the number that will be dialled.
                                placeholder={String(DEFAULT_PORTS[driver])}
                                disabled={mongoUriManual}
                                onChange={(e) =>
                                  setPort(Number(e.target.value))
                                }
                              />
                            </Field>
                          </div>
                          <Field label={t("connectionDialog.fields.database")}>
                            <Input
                              value={database}
                              disabled={mongoUriManual}
                              onChange={(e) => setDatabase(e.target.value)}
                            />
                          </Field>
                          <Field label={t("connectionDialog.fields.username")}>
                            <Input
                              value={username}
                              disabled={mongoUriManual}
                              onChange={(e) => setUsername(e.target.value)}
                            />
                          </Field>
                          <Field label={t("connectionDialog.fields.password")}>
                            <PasswordInput
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              placeholder={
                                editingId
                                  ? t(
                                      "connectionDialog.fields.passwordKeepHint",
                                    )
                                  : ""
                              }
                            />
                          </Field>
                          <Field
                            label={t("connectionDialog.fields.authSource")}
                          >
                            <Input
                              value={authSource}
                              disabled={mongoUriManual}
                              onChange={(e) => setAuthSource(e.target.value)}
                              placeholder={t(
                                "connectionDialog.fields.authSourcePlaceholder",
                              )}
                            />
                          </Field>
                          {/* Same shape as the two switch rows below/above in
                              the other driver branches. Disabled in raw-edit
                              mode like every field here: there the URI text is
                              the source of truth, and a toggle that silently
                              rewrote it would fight the user's own edits. */}
                          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                            <div className="min-w-0">
                              <Label className="text-sm">
                                {t(
                                  "connectionDialog.fields.directConnection",
                                )}
                              </Label>
                              <p className="mt-0.5 text-2xs text-muted-foreground">
                                {t(
                                  "connectionDialog.fields.directConnectionHint",
                                )}
                              </p>
                            </div>
                            <Switch
                              checked={mongoDirectConnection}
                              disabled={mongoUriManual}
                              onCheckedChange={setMongoDirectConnection}
                            />
                          </div>

                          {/* Derived connection string + raw-edit escape hatch. */}
                          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                            <Label className="text-sm">
                              {t(
                                "connectionDialog.fields.editConnectionString",
                              )}
                            </Label>
                            <Switch
                              checked={mongoUriManual}
                              onCheckedChange={onToggleMongoUriManual}
                            />
                          </div>
                          <Field
                            label={t(
                              "connectionDialog.fields.connectionString",
                            )}
                          >
                            <Input
                              value={effectiveMongoUri}
                              readOnly={!mongoUriManual}
                              onChange={(e) =>
                                setConnectionString(e.target.value)
                              }
                              placeholder={t(
                                "connectionDialog.fields.connectionStringPlaceholder",
                              )}
                              className={
                                mongoUriManual
                                  ? undefined
                                  : "text-muted-foreground"
                              }
                            />
                          </Field>
                          {mongoUriManual ? (
                            <p className="-mt-1 rounded-sm border border-warning/40 bg-warning/10 px-2 py-1.5 text-2xs text-warning">
                              {t(
                                "connectionDialog.fields.connectionStringWarning",
                              )}
                            </p>
                          ) : (
                            <p className="-mt-1 text-2xs text-muted-foreground">
                              {t(
                                "connectionDialog.fields.connectionStringHint",
                              )}
                            </p>
                          )}
                        </>
                      ) : driver !== "sqlite" ? (
                        <>
                          <div className="grid grid-cols-3 gap-2">
                            <div className="col-span-2">
                              <Field label={t("connectionDialog.fields.host")}>
                                <Input
                                  value={host}
                                  onChange={(e) => setHost(e.target.value)}
                                  onBlur={normalizeServerName}
                                />
                              </Field>
                            </div>
                            <Field label={t("connectionDialog.fields.port")}>
                              <Input
                                type="number"
                                value={port || ""}
                                // See the MongoDB field above: an empty port
                                // means the driver's default, and saying which
                                // one is what makes leaving it empty safe.
                                placeholder={String(DEFAULT_PORTS[driver])}
                                onChange={(e) =>
                                  setPort(Number(e.target.value))
                                }
                              />
                            </Field>
                          </div>
                          <Field label={t("connectionDialog.fields.database")}>
                            <Input
                              value={database}
                              onChange={(e) => setDatabase(e.target.value)}
                            />
                          </Field>
                          <Field label={t("connectionDialog.fields.username")}>
                            <Input
                              value={username}
                              onChange={(e) => setUsername(e.target.value)}
                            />
                          </Field>
                          <Field label={t("connectionDialog.fields.password")}>
                            <PasswordInput
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              placeholder={
                                editingId
                                  ? t(
                                      "connectionDialog.fields.passwordKeepHint",
                                    )
                                  : ""
                              }
                            />
                          </Field>
                          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                            <Label className="text-sm">
                              {t("connectionDialog.fields.ssl")}
                            </Label>
                            <Switch checked={ssl} onCheckedChange={setSsl} />
                          </div>
                          <Field
                            label={t("connectionDialog.fields.maxConnections")}
                            hint={t(
                              "connectionDialog.fields.maxConnectionsHint",
                            )}
                          >
                            <Input
                              type="number"
                              min={2}
                              max={64}
                              value={maxConnections}
                              onChange={(e) =>
                                setMaxConnections(e.target.value)
                              }
                              placeholder={t(
                                "connectionDialog.fields.maxConnectionsPlaceholder",
                              )}
                            />
                          </Field>
                          {/* Sits next to the pool ceiling because both are
                              statements about this server rather than about the
                              session: how much of it we may use, and how long
                              it is allowed to take. Blank means the global
                              preference, which the placeholder names. */}
                          <Field
                            label={t(
                              "connectionDialog.fields.operationTimeout",
                            )}
                            hint={t(
                              "connectionDialog.fields.operationTimeoutHint",
                            )}
                          >
                            <Input
                              type="number"
                              min={5}
                              max={600}
                              value={operationTimeout}
                              onChange={(e) =>
                                setOperationTimeout(e.target.value)
                              }
                              placeholder={t(
                                "connectionDialog.fields.operationTimeoutPlaceholder",
                                { seconds: connectionPrefs.operationTimeoutSecs },
                              )}
                            />
                          </Field>
                          {driver === "sqlserver" && (
                            <>
                              <Field
                                label={t(
                                  "connectionDialog.fields.mssqlInstance",
                                )}
                                hint={t(
                                  "connectionDialog.fields.mssqlInstanceHint",
                                )}
                              >
                                <Input
                                  value={mssqlInstance}
                                  onChange={(e) =>
                                    setMssqlInstance(e.target.value)
                                  }
                                  onBlur={normalizeServerName}
                                  placeholder={t(
                                    "connectionDialog.fields.mssqlInstancePlaceholder",
                                  )}
                                />
                              </Field>
                              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                                <div className="pr-3">
                                  <Label className="text-sm">
                                    {t(
                                      "connectionDialog.fields.mssqlTrustCert",
                                    )}
                                  </Label>
                                  <p className="mt-0.5 text-xs text-muted-foreground">
                                    {t(
                                      "connectionDialog.fields.mssqlTrustCertHint",
                                    )}
                                  </p>
                                </div>
                                <Switch
                                  checked={mssqlTrustCert}
                                  onCheckedChange={setMssqlTrustCert}
                                />
                              </div>
                              {/* NTLM is only compiled into Windows builds (the
                                driver gates `AuthMethod::Windows` at compile
                                time), so don't offer a mode that can only
                                fail elsewhere. */}
                              {onWindows && (
                                <Field
                                  label={t("connectionDialog.fields.mssqlAuth")}
                                >
                                  <Select
                                    value={mssqlAuth}
                                    onValueChange={(v) =>
                                      setMssqlAuth(v as MsSqlAuth)
                                    }
                                  >
                                    <SelectTrigger>
                                      {t(
                                        `connectionDialog.fields.mssqlAuth_${mssqlAuth}`,
                                      )}
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="sql">
                                        {t(
                                          "connectionDialog.fields.mssqlAuth_sql",
                                        )}
                                      </SelectItem>
                                      <SelectItem value="windows">
                                        {t(
                                          "connectionDialog.fields.mssqlAuth_windows",
                                        )}
                                      </SelectItem>
                                    </SelectContent>
                                  </Select>
                                </Field>
                              )}
                            </>
                          )}
                        </>
                      ) : (
                        <Field label={t("connectionDialog.fields.sqlitePath")}>
                          <Input
                            value={database}
                            onChange={(e) => setDatabase(e.target.value)}
                            placeholder={t(
                              "connectionDialog.fields.sqlitePathPlaceholder",
                            )}
                          />
                        </Field>
                      )}
                    </div>
                  </TabsContent>

                  <TabsContent value="ssh" className="pt-3">
                    {tunnelTabDisabled ? (
                      <div className="px-1 py-3 text-xs text-muted-foreground">
                        {isMongoSrv
                          ? t("connectionDialog.ssh.unavailableForSrv")
                          : t("connectionDialog.ssh.unavailableForSqlite")}
                      </div>
                    ) : (
                      <div className="grid gap-3">
                        <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                          <Label className="text-sm">
                            {t("connectionDialog.ssh.enable")}
                          </Label>
                          <Switch
                            checked={sshEnabled}
                            onCheckedChange={setSshEnabled}
                          />
                        </div>
                        {sshEnabled && (
                          <>
                            <div className="grid grid-cols-3 gap-2">
                              <div className="col-span-2 min-w-0">
                                <Field label={t("connectionDialog.ssh.host")}>
                                  <Input
                                    value={sshHost}
                                    onChange={(e) => setSshHost(e.target.value)}
                                  />
                                </Field>
                              </div>
                              <Field label={t("connectionDialog.ssh.port")}>
                                <Input
                                  type="number"
                                  value={sshPort || ""}
                                  onChange={(e) =>
                                    setSshPort(Number(e.target.value))
                                  }
                                />
                              </Field>
                            </div>
                            <Field label={t("connectionDialog.ssh.username")}>
                              <Input
                                value={sshUsername}
                                onChange={(e) => setSshUsername(e.target.value)}
                              />
                            </Field>
                            <Field label={t("connectionDialog.ssh.authMethod")}>
                              <Select
                                value={sshAuthMethod}
                                onValueChange={(v) =>
                                  setSshAuthMethod(v as SshAuthMethod)
                                }
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="password">
                                    {t("connectionDialog.ssh.authPassword")}
                                  </SelectItem>
                                  <SelectItem value="key">
                                    {t("connectionDialog.ssh.authKey")}
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                            </Field>

                            {sshAuthMethod === "password" ? (
                              <Field
                                label={t("connectionDialog.ssh.sshPassword")}
                              >
                                <PasswordInput
                                  value={sshSecret}
                                  onChange={(e) => setSshSecret(e.target.value)}
                                  placeholder={
                                    editingId
                                      ? t(
                                          "connectionDialog.ssh.passphraseKeepHint",
                                        )
                                      : ""
                                  }
                                />
                              </Field>
                            ) : (
                              <>
                                <Field
                                  label={t(
                                    "connectionDialog.ssh.privateKeyPath",
                                  )}
                                >
                                  <div className="flex min-w-0 gap-2">
                                    <Input
                                      className="min-w-0 flex-1"
                                      value={sshKeyPath}
                                      onChange={(e) =>
                                        setSshKeyPath(e.target.value)
                                      }
                                      placeholder={t(
                                        "connectionDialog.ssh.privateKeyPathPlaceholder",
                                      )}
                                    />
                                    <Button
                                      type="button"
                                      variant="outline"
                                      className="shrink-0"
                                      onClick={onPickKeyFile}
                                    >
                                      {t("connectionDialog.ssh.browse")}
                                    </Button>
                                  </div>
                                </Field>
                                <Field
                                  label={t("connectionDialog.ssh.passphrase")}
                                >
                                  <PasswordInput
                                    value={sshSecret}
                                    onChange={(e) =>
                                      setSshSecret(e.target.value)
                                    }
                                    placeholder={
                                      editingId
                                        ? t(
                                            "connectionDialog.ssh.passphraseKeepHint",
                                          )
                                        : ""
                                    }
                                  />
                                </Field>
                              </>
                            )}

                            <Field label={t("connectionDialog.ssh.localPort")}>
                              <Input
                                type="number"
                                value={sshLocalPort || ""}
                                onChange={(e) =>
                                  setSshLocalPort(Number(e.target.value))
                                }
                                placeholder={t(
                                  "connectionDialog.ssh.localPortAuto",
                                )}
                              />
                            </Field>
                            <p className="-mt-1 text-2xs text-muted-foreground">
                              {t("connectionDialog.ssh.localPortHint")}
                            </p>

                            <Field
                              label={t("connectionDialog.ssh.hostKeyPolicy")}
                            >
                              <Select
                                value={sshHostKeyPolicy}
                                onValueChange={(v) =>
                                  setSshHostKeyPolicy(v as HostKeyPolicy)
                                }
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="accept-new">
                                    {t("connectionDialog.ssh.policyAcceptNew")}
                                  </SelectItem>
                                  <SelectItem value="strict">
                                    {t("connectionDialog.ssh.policyStrict")}
                                  </SelectItem>
                                  <SelectItem value="accept-any">
                                    {t("connectionDialog.ssh.policyAcceptAny")}
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                            </Field>
                            <p className="-mt-1 text-2xs text-muted-foreground">
                              {t("connectionDialog.ssh.hostKeyPolicyHint")}
                            </p>

                            {sshHost && (
                              <div className="rounded-md border border-border px-3 py-2 text-2xs">
                                <div className="mb-1 font-medium text-muted-foreground">
                                  {t("connectionDialog.ssh.trustedFingerprint")}
                                </div>
                                {trustedFingerprint ? (
                                  <div className="flex items-center gap-2">
                                    <code className="flex-1 truncate font-mono text-3xs">
                                      {trustedFingerprint}
                                    </code>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={onForgetHostKey}
                                    >
                                      {t("connectionDialog.ssh.forgetHostKey")}
                                    </Button>
                                  </div>
                                ) : (
                                  <div className="text-muted-foreground">
                                    {t(
                                      "connectionDialog.ssh.noTrustedFingerprint",
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              </div>

              {/* Action footer */}
              <div className="border-t border-border px-5 py-3">
                {statusText &&
                  (isErrorStatus ? (
                    // Long DB errors used to truncate at the dialog edge. Give
                    // them a bounded, wrapping, scrollable box with a copy
                    // affordance instead of a single clipped line.
                    <div className="mb-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
                      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                      <p className="max-h-24 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-destructive">
                        {statusText}
                      </p>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0 text-destructive hover:text-destructive"
                            onClick={onCopyError}
                          >
                            {errorCopied ? (
                              <Check className="h-3.5 w-3.5" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="left">
                          {t("connectionDialog.copyError")}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  ) : (
                    <div className={cn("mb-2 truncate text-xs", statusClass)}>
                      {statusText}
                    </div>
                  ))}
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    onClick={onTest}
                    disabled={busy || !name}
                  >
                    {t("connectionDialog.test")}
                  </Button>
                  {editingId && (
                    <Button
                      variant="ghost"
                      onClick={onDuplicate}
                      disabled={busy}
                      icon={Copy}
                    >
                      {t("connectionDialog.duplicate")}
                    </Button>
                  )}
                  {editingId && !fromOrigin && (
                    <Button
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={onDelete}
                      disabled={busy}
                      icon={Trash2}
                    >
                      {t("connectionDialog.delete")}
                    </Button>
                  )}
                  <div className="ml-auto flex items-center gap-2">
                    <Button
                      variant="outline"
                      onClick={onConnect}
                      disabled={busy || !name}
                      icon={Plug}
                    >
                      {connecting
                        ? t("connectionDialog.connecting")
                        : t("connectionDialog.connect")}
                    </Button>
                    <Button
                      onClick={onSave}
                      disabled={
                        busy || !name || (fromOrigin && !canEditInPlace)
                      }
                    >
                      {saving
                        ? t("connectionDialog.saving")
                        : t("connectionDialog.save")}
                    </Button>
                  </div>
                </div>
              </div>
            </main>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <ExportProfilesDialog open={exportOpen} onOpenChange={setExportOpen} />
      <ImportProfilesDialog open={importOpen} onOpenChange={setImportOpen} />
      {deleteTargets.length > 0 && (
        <DeleteConnectionsDialog
          targets={deleteTargets}
          onClose={() => setDeleteTargets([])}
          onDeleted={(report) => {
            setDeleteTargets([]);
            // Fall back to a fresh draft if the editor was showing one of them;
            // the load effect repopulates the form.
            if (editingId && report.deleted.includes(editingId)) {
              setEditingId(null);
            }
          }}
        />
      )}
      <MongoUriFoldDialog
        lost={mongoFoldConflict}
        onConfirm={() => {
          const lost = mongoFoldConflict ?? [];
          confirmMongoUriFold();
          // The form visibly repopulates, so the fold itself needs no
          // announcement — what does is the part that is *not* on screen: the
          // hosts, the SRV lookup or the password that just stopped existing.
          // A pill, since the count is the whole message (gotcha #64).
          notify.warning(t("connectionDialog.mongoFoldDone"), {
            description: lost
              .map((reason) =>
                t(`connectionDialog.mongoFold.lostShort.${reason}`),
              )
              .join(", "),
          });
        }}
        onCancel={cancelMongoUriFold}
      />
    </>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  /** Optional one-line explanation under the control, for a field whose label
   *  can't carry the whole meaning (e.g. what leaving it blank does). */
  hint?: string;
  children: React.ReactNode;
}) {
  // `min-w-0` lets the field shrink inside flex/grid parents instead of forcing
  // its content's intrinsic width and overflowing (e.g. a long SSH key path).
  return (
    <div className="grid min-w-0 gap-1">
      <Label>{label}</Label>
      {children}
      {hint && (
        <p className="text-2xs leading-snug text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/**
 * Free-text "creatable" combobox for the Group field. Replaces the native
 * `<datalist>` (issue #21), whose suggestion popup is drawn by the OS/webview
 * and ignores the app theme. This is a themed popover anchored under the
 * input: it lists matching existing group names but never constrains the
 * value — typing a brand-new name still creates a new group on save.
 */
function GroupCombobox({
  value,
  onChange,
  suggestions,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Show every other group when the field is empty, else substring-filter —
  // and never suggest the exact value already typed (nothing to pick).
  const matches = useMemo(() => {
    const term = value.trim().toLowerCase();
    return suggestions.filter(
      (g) =>
        g.toLowerCase() !== term && (!term || g.toLowerCase().includes(term)),
    );
  }, [suggestions, value]);

  // Close on any click outside the combobox subtree.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <Input
        value={value}
        autoComplete="off"
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && matches.length > 0 && (
        <div
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-elevation-3"
          // Keep the input focused when a suggestion is clicked so the click
          // resolves before the outside-click handler can fire.
          onMouseDown={(e) => e.preventDefault()}
        >
          {matches.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => {
                onChange(g);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
            >
              <Folder className="h-3 w-3 shrink-0 opacity-60" />
              <span className="truncate">{g}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
