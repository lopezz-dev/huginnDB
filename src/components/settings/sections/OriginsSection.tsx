/**
 * Settings → Origins: register the shared files HuginnDB pulls connections
 * from (#108), and sync them on demand.
 *
 * Global, unlike most of what touches `tab_state.json`: an origin describes a
 * server-side resource, not a Producción/Staging axis, and what it produces
 * (profiles, whole mirrored environments) is already global — see
 * `commands::origins`'s module doc for why. So this section, unlike its
 * neighbours, is the same regardless of which environment is active.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notify";
import {
  Check,
  Database,
  Eye,
  FileJson,
  FilePlus2,
  Layers,
  FolderOpen,
  FolderSync,
  KeyRound,
  PencilLine,
  Plus,
  RefreshCw,
  SquarePen,
  Trash2,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { IconButton } from "@/components/ui/icon-button";
import { api } from "@/lib/tauri";
import { pickJsonFile, pickJsonSavePath } from "@/lib/dialogs";
import { useOriginEditor } from "@/stores/dialogs/originEditor";
import { useOriginSync } from "@/stores/sync/originSync";
import { useOrigins } from "@/stores/sync/origins";
import { useConnections } from "@/stores/session/connections";
import { useEnvironments } from "@/stores/session/environments";
import { VanishedOriginNotice } from "@/components/common/VanishedOriginNotice";
import { VanishedEnvironmentNotice } from "@/components/common/VanishedEnvironmentNotice";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MICRO_HEADING } from "@/components/ui/styles";
import { PrefGroup } from "./PrefGroup";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/common/PasswordInput";
import type { Origin, OriginRole } from "@/types";
import { FULL_SCOPE, isFullScope, originScope } from "@/lib/origins/scope";
import { localPasswordNames } from "@/lib/connection/origin";
import { OriginScopeFields } from "@/components/origins/OriginScopeFields";
import { formatDateTime } from "@/lib/utils";

export function OriginsSection() {
  const { t } = useTranslation();
  const syncing = useOriginSync((s) => s.syncing);
  const errors = useOriginSync((s) => s.errors);
  const syncAll = useOriginSync((s) => s.syncAll);
  const vanished = useOriginSync((s) => s.vanished);
  const vanishedEnvironments = useOriginSync((s) => s.vanishedEnvironments);
  const noticeOriginRemoved = useOriginSync((s) => s.noticeOriginRemoved);
  const adoptAllVanished = useOriginSync((s) => s.adoptAllVanished);
  const retireAllVanished = useOriginSync((s) => s.retireAllVanished);
  const profiles = useConnections((s) => s.profiles);
  const environments = useEnvironments((s) => s.environments);

  // Derive the id list here rather than in the selector: `Object.keys` returns a
  // fresh array on every call and would re-render forever (gotcha #1).
  const vanishedIds = useMemo(() => Object.keys(vanished), [vanished]);
  const vanishedEnvironmentIds = useMemo(
    () => Object.keys(vanishedEnvironments),
    [vanishedEnvironments],
  );

  // The registry lives in `stores/sync/origins.ts`, not in local state: the
  // connection manager and the MCP panel need the same id→name map, and the
  // `origins-changed` event keeps every window's copy fresh — which also means
  // "Sync now" below no longer has to remember to re-read `lastSyncedAt`.
  const origins = useOrigins((s) => s.origins);

  // Per origin, the connections running on a password typed on this machine.
  // Derived here, not in a selector, for gotcha #1's reason.
  const localPasswords = useMemo(
    () => new Map(origins.map((o) => [o.id, localPasswordNames(profiles, o.id)])),
    [origins, profiles],
  );
  const loadOrigins = useOrigins((s) => s.load);
  const openEditor = useOriginEditor((s) => s.open);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    path: "",
    passphrase: "",
    scope: FULL_SCOPE,
  });
  const [busy, setBusy] = useState(false);
  // `updateOrigin` shipped in 1.18 with **zero** call sites: an origin could be
  // registered and removed but never renamed or repointed, so a moved share
  // meant deleting the registration and re-adopting every connection it had
  // published. This is that missing surface.
  const [editing, setEditing] = useState<Origin | null>(null);
  const [edit, setEdit] = useState({
    name: "",
    path: "",
    passphrase: "",
    role: "consumer" as OriginRole,
    scope: FULL_SCOPE,
  });
  // Turning on write access is confirmed separately from saving the rest of the
  // registration, because it is the one field that changes what the app is
  // allowed to do to somebody else's file.
  const [confirmPublisher, setConfirmPublisher] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newDoc, setNewDoc] = useState({ path: "", name: "", maintainer: "" });
  const [pendingRemove, setPendingRemove] = useState<Origin | null>(null);
  const [removing, setRemoving] = useState(false);
  const [bulkAdopting, setBulkAdopting] = useState(false);
  const [bulkRetireOpen, setBulkRetireOpen] = useState(false);
  const [bulkRetiring, setBulkRetiring] = useState(false);

  // How many connections/environments will be flagged as orphaned if this
  // origin goes — shown in the confirm dialog so "what it published stays"
  // isn't an abstract warning.
  const affectedConnectionCount = useMemo(
    () =>
      pendingRemove
        ? profiles.filter((p) => p.origin_id === pendingRemove.id).length
        : 0,
    [profiles, pendingRemove],
  );
  const affectedEnvironmentCount = useMemo(
    () =>
      pendingRemove
        ? environments.filter((e) => e.originId === pendingRemove.id).length
        : 0,
    [environments, pendingRemove],
  );

  /**
   * Run one origin mutation, and say so when it fails.
   *
   * All six handlers below were `try { … } finally { setBusy(false) }` with no
   * `catch`: a rejected IPC call left an unhandled rejection in the console and
   * the user staring at a dialog that had simply stopped responding. Registering
   * an origin, publishing to one, or retiring a vanished profile are all writes
   * whose effect is somewhere else entirely, so there is nothing on screen to
   * read the outcome off — exactly the case CONTRIBUTING's doctrine says must
   * report.
   */
  async function run(
    setPending: (busy: boolean) => void,
    titleKey: string,
    body: () => Promise<void>,
  ) {
    setPending(true);
    try {
      await body();
    } catch (e) {
      notify.error(t(titleKey), { description: String(e) });
    } finally {
      setPending(false);
    }
  }

  async function performRemove() {
    if (!pendingRemove) return;
    await run(setRemoving, "origins.removeFailed", async () => {
      // Raise the vanished-notice *before* the origin is gone: once removed
      // it drops out of `listOrigins()`, and `syncAll()` — the only other
      // place that populates `vanished` — has nothing left to iterate to
      // ever report these as orphaned.
      noticeOriginRemoved(pendingRemove);
      await api.removeOrigin(pendingRemove.id);
      // The backend's `origins-changed` event refreshes the store too, but
      // awaiting it here means the row is gone before the dialog closes rather
      // than a frame later.
      await loadOrigins();
      setPendingRemove(null);
    });
  }

  async function performBulkAdopt() {
    await run(setBulkAdopting, "origins.adoptFailed", adoptAllVanished);
  }

  async function performBulkRetire() {
    await run(setBulkRetiring, "origins.retireFailed", async () => {
      await retireAllVanished();
      setBulkRetireOpen(false);
    });
  }

  function beginEdit(o: Origin) {
    setEditing(o);
    setEdit({
      name: o.name,
      path: o.path,
      // Empty means "leave the stored one alone" — `updateOrigin`'s tri-state
      // passphrase. Prefilling it with anything would make a rename retype a
      // secret the user already stored.
      passphrase: "",
      role: o.role ?? "consumer",
      // Through the helper, never `o.scope` directly: an origin registered
      // before the field existed pulls everything, and reading the absent case
      // as "nothing" would show a state the backend does not implement.
      scope: originScope(o),
    });
  }

  async function saveEdit() {
    if (!editing || !edit.path.trim()) return;
    await run(setBusy, "origins.saveFailed", async () => {
      await api.updateOrigin({
        id: editing.id,
        name: edit.name.trim() || edit.path,
        path: edit.path.trim(),
        passphrase: edit.passphrase ? edit.passphrase : null,
        role: edit.role,
        scope: edit.scope,
      });
      setEditing(null);
      await loadOrigins();
    });
  }

  async function createDocument() {
    if (!newDoc.path.trim()) return;
    await run(setBusy, "origins.createDocumentFailed", async () => {
      const created = await api.createOriginDocument({
        path: newDoc.path.trim(),
        name: newDoc.name.trim() || newDoc.path.trim(),
        maintainer: newDoc.maintainer.trim() || null,
      });
      setNewDoc({ path: "", name: "", maintainer: "" });
      setCreating(false);
      await loadOrigins();
      // Straight into the editor: an empty document nobody is invited to fill
      // in reads as a command that did nothing.
      openEditor(created.id);
    });
  }

  async function submit() {
    if (!draft.path.trim()) return;
    await run(setBusy, "origins.addFailed", async () => {
      await api.addOrigin({
        name: draft.name.trim() || draft.path,
        path: draft.path.trim(),
        // Empty means "not encrypted" — nothing is written to the keychain.
        passphrase: draft.passphrase || null,
        scope: draft.scope,
      });
      setDraft({ name: "", path: "", passphrase: "", scope: FULL_SCOPE });
      setAdding(false);
      await loadOrigins();
      // Pull immediately: registering an origin and seeing nothing happen reads
      // as broken, and this is the one moment the user is definitely watching.
      await syncAll();
    });
  }

  return (
    <div className="space-y-5">
      {/* The title comes from the dialog's section header; this keeps only
          the explanation, which says more than the rail's one-liner. */}
      <p className="text-xs text-muted-foreground">
        {t("origins.description")}
      </p>

      <PrefGroup
        title={t("origins.listTitle")}
        action={
          <>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void syncAll()}
              // Not gated on `origins.length`: `syncAll` also runs the orphan
              // reconciliation sweep (`reconcileOrphans`), which is useful even
              // with zero origins left — e.g. right after removing the last one,
              // before its connections' vanished notice has had a chance to run.
              icon={RefreshCw}
              loading={syncing}
            >
              {t("origins.syncNow")}
            </Button>
            <Button size="xs" variant="outline" icon={Plus} onClick={() => setAdding(true)}>
              {t("origins.add")}
            </Button>
            <Button
              size="xs"
              variant="outline"
              icon={FilePlus2}
              onClick={() => setCreating(true)}
            >
              {t("origins.newDocument")}
            </Button>
          </>
        }
      >
        {origins.length === 0 ? (
          <p className="px-4 py-5 text-center text-xs text-muted-foreground">
            {t("origins.empty")}
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {origins.map((o) => (
              <div key={o.id} className="flex items-start gap-3 px-4 py-3">
                <FolderSync className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm">{o.name}</span>
                    {/* Intention, not authority: the editor probes the path
                        itself and opens read-only if the OS refuses a write, no
                        matter what this says. */}
                    <Badge
                      size="xs"
                      tone={(o.role ?? "consumer") === "publisher" ? "brand" : "neutral"}
                    >
                      {(o.role ?? "consumer") === "publisher" ? (
                        <PencilLine className="h-3 w-3" />
                      ) : (
                        <Eye className="h-3 w-3" />
                      )}
                      {t(`origins.role.${o.role ?? "consumer"}`)}
                    </Badge>
                    {/* Only when it is not the default. A badge on every row
                        would be noise for the majority who pull everything, and
                        the point of this one is that a narrowed origin looks
                        different from a broken one when a slice turns up
                        missing. */}
                    {!isFullScope(originScope(o)) && (
                      <SimpleTooltip label={t("origins.scope.badgeTitle")}>
                        <Badge size="xs" tone="neutral">
                          {originScope(o).connections && (
                            <Database className="h-3 w-3" />
                          )}
                          {originScope(o).environments && (
                            <Layers className="h-3 w-3" />
                          )}
                          {originScope(o).schemas && (
                            <FileJson className="h-3 w-3" />
                          )}
                          {t("origins.scope.badge")}
                        </Badge>
                      </SimpleTooltip>
                    )}
                    {/* Which of this origin's connections run on a password
                        typed here rather than the published one (ADR #69).
                        Counted per origin because the fix — the curator
                        republishing — is per origin too; the names are in
                        the tooltip, the rail marks each row. */}
                    {(localPasswords.get(o.id)?.length ?? 0) > 0 && (
                      <SimpleTooltip
                        label={t("origins.localPasswords.title", {
                          names: localPasswords.get(o.id)!.join(", "),
                        })}
                      >
                        <Badge size="xs" tone="neutral">
                          <KeyRound className="h-3 w-3" />
                          {t("origins.localPasswords.badge", {
                            count: localPasswords.get(o.id)!.length,
                          })}
                        </Badge>
                      </SimpleTooltip>
                    )}
                    {o.maintainer && (
                      <span className="shrink-0 truncate text-3xs text-muted-foreground">
                        {t("origins.curatedBy", { who: o.maintainer })}
                      </span>
                    )}
                  </div>
                  {/* The path is the identifying detail when two origins share a
                      name, and it's what the user checks when a sync fails, so it
                      stays visible rather than living in a tooltip. */}
                  <div className="truncate font-mono text-2xs text-muted-foreground">
                    {o.path}
                  </div>
                  <div className="mt-0.5 text-2xs text-muted-foreground">
                    {o.lastSyncedAt
                      ? t("origins.lastSynced", {
                          when: formatDateTime(o.lastSyncedAt),
                        })
                      : t("origins.neverSynced")}
                  </div>
                  {errors[o.id] && (
                    <div className="mt-1 break-words text-2xs text-destructive">
                      {errors[o.id]}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <IconButton
                    icon={SquarePen}
                    label={t("origins.editContent")}
                    onClick={() => openEditor(o.id)}
                  />
                  <IconButton
                    icon={PencilLine}
                    label={t("origins.editRegistration")}
                    onClick={() => beginEdit(o)}
                  />
                  <IconButton
                    icon={Trash2}
                    tone="destructive"
                    label={t("origins.remove")}
                    onClick={() => setPendingRemove(o)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </PrefGroup>

      {/* The reliable surface for a notice: a vanished connection that isn't
          open never renders a schema tree, so the tree banner alone would leave
          it unresolvable. */}
      {vanishedIds.length > 0 && (
        <div>
          <div className="flex items-center justify-between gap-2">
            <h3 className={MICRO_HEADING}>{t("origins.vanished.pending")}</h3>
            <div className="flex items-center gap-1.5">
              <Button
                size="xs"
                variant="outline"
                icon={Check}
                loading={bulkAdopting}
                disabled={bulkRetiring}
                onClick={() => void performBulkAdopt()}
              >
                {t("origins.vanished.keepAll")}
              </Button>
              <Button
                size="xs"
                variant="outline"
                icon={Trash2}
                className="text-destructive hover:text-destructive"
                disabled={bulkAdopting || bulkRetiring}
                onClick={() => setBulkRetireOpen(true)}
              >
                {t("origins.vanished.retireAll")}
              </Button>
            </div>
          </div>
          {vanishedIds.map((id) => (
            <VanishedOriginNotice
              key={id}
              profileId={id}
              showConnection
              className="mx-0 mt-2"
            />
          ))}
        </div>
      )}

      {vanishedEnvironmentIds.length > 0 && (
        <div>
          <h3 className={MICRO_HEADING}>
            {t("origins.vanishedEnvironments.pending")}
          </h3>
          {vanishedEnvironmentIds.map((id) => (
            <VanishedEnvironmentNotice
              key={id}
              environmentId={id}
              className="mx-0 mt-2"
            />
          ))}
        </div>
      )}

      {adding && (
        <PrefGroup title={t("origins.addTitle")} padded>
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              placeholder={t("origins.pathPlaceholder")}
              value={draft.path}
              onChange={(e) =>
                setDraft((d) => ({ ...d, path: e.target.value }))
              }
            />
            {/* Typing a UNC path by hand is how a registration ends up
                pointing one character away from the share. */}
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void pickJsonFile(t("origins.browseTitle")).then(
                  (picked) =>
                    picked && setDraft((d) => ({ ...d, path: picked })),
                )
              }
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Input
            placeholder={t("origins.namePlaceholder")}
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          <PasswordInput
            placeholder={t("origins.passphrasePlaceholder")}
            value={draft.passphrase}
            onChange={(e) =>
              setDraft((d) => ({ ...d, passphrase: e.target.value }))
            }
          />
          <p className="text-2xs text-muted-foreground">
            {t("origins.passphraseHint")}
          </p>
          <OriginScopeFields
            value={draft.scope}
            onChange={(scope) => setDraft((d) => ({ ...d, scope }))}
            path={draft.path}
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAdding(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={busy || !draft.path.trim()}
              onClick={() => void submit()}
            >
              {busy ? t("origins.adding") : t("common.save")}
            </Button>
          </div>
        </PrefGroup>
      )}

      {editing && (
        <PrefGroup
          title={t("origins.editRegistrationTitle", { name: editing.name })}
          padded
        >
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              placeholder={t("origins.pathPlaceholder")}
              value={edit.path}
              onChange={(e) => setEdit((d) => ({ ...d, path: e.target.value }))}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void pickJsonFile(t("origins.browseTitle")).then(
                  (picked) =>
                    picked && setEdit((d) => ({ ...d, path: picked })),
                )
              }
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Input
            placeholder={t("origins.namePlaceholder")}
            value={edit.name}
            onChange={(e) => setEdit((d) => ({ ...d, name: e.target.value }))}
          />
          <PasswordInput
            placeholder={t("origins.passphraseKeepPlaceholder")}
            value={edit.passphrase}
            onChange={(e) =>
              setEdit((d) => ({ ...d, passphrase: e.target.value }))
            }
          />
          <p className="text-2xs text-muted-foreground">
            {t("origins.passphraseKeepHint")}
          </p>
          <OriginScopeFields
            value={edit.scope}
            onChange={(scope) => setEdit((d) => ({ ...d, scope }))}
            path={edit.path}
          />
          {/* Narrowing a scope is non-destructive and the form has to say so,
              because the obvious reading of unticking a box is that what it
              brought in goes away. It stays, tagged and read-only, and simply
              stops being refreshed — detaching it is a separate act. */}
          <p className="text-3xs text-muted-foreground">
            {t("origins.scope.narrowingKeeps")}
          </p>
          <label className="flex items-start gap-2 text-2xs">
            <Checkbox
              className="mt-0.5"
              checked={edit.role === "publisher"}
              onChange={(e) => {
                // Reversible without ceremony, granted with it.
                if (e.target.checked) setConfirmPublisher(true);
                else setEdit((d) => ({ ...d, role: "consumer" }));
              }}
            />
            <span>
              {t("origins.role.publisherToggle")}
              <span className="block text-muted-foreground">
                {t("origins.role.publisherToggleHint")}
              </span>
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              loading={busy}
              disabled={!edit.path.trim()}
              onClick={() => void saveEdit()}
            >
              {t("common.save")}
            </Button>
          </div>
        </PrefGroup>
      )}

      {creating && (
        <PrefGroup
          title={t("origins.newDocumentTitle")}
          description={t("origins.newDocumentHint")}
          padded
        >
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              placeholder={t("origins.pathPlaceholder")}
              value={newDoc.path}
              onChange={(e) =>
                setNewDoc((d) => ({ ...d, path: e.target.value }))
              }
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void pickJsonSavePath(
                  t("origins.newDocumentBrowseTitle"),
                  "huginndb-team.json",
                ).then(
                  (picked) =>
                    picked && setNewDoc((d) => ({ ...d, path: picked })),
                )
              }
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Input
            placeholder={t("origins.namePlaceholder")}
            value={newDoc.name}
            onChange={(e) => setNewDoc((d) => ({ ...d, name: e.target.value }))}
          />
          <Input
            placeholder={t("origins.maintainerPlaceholder")}
            value={newDoc.maintainer}
            onChange={(e) =>
              setNewDoc((d) => ({ ...d, maintainer: e.target.value }))
            }
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCreating(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              loading={busy}
              disabled={!newDoc.path.trim()}
              onClick={() => void createDocument()}
            >
              {t("origins.newDocumentCreate")}
            </Button>
          </div>
        </PrefGroup>
      )}

      <ConfirmDialog
        open={confirmPublisher}
        onOpenChange={(open) => !open && setConfirmPublisher(false)}
        title={t("origins.role.confirmTitle")}
        description={
          <div className="space-y-1">
            <p>{t("origins.role.confirmBody")}</p>
            <p className="break-all font-mono text-2xs">{edit.path}</p>
            <p>{t("origins.role.confirmReversible")}</p>
          </div>
        }
        confirmLabel={t("origins.role.confirmAccept")}
        onConfirm={() => {
          setEdit((d) => ({ ...d, role: "publisher" }));
          setConfirmPublisher(false);
        }}
      />

      <ConfirmDialog
        open={!!pendingRemove}
        onOpenChange={(open) => !open && setPendingRemove(null)}
        title={t("origins.removeConfirmTitle", {
          name: pendingRemove?.name ?? "",
        })}
        description={
          <div className="space-y-1">
            <p>{t("origins.removeConfirmPassphraseNote")}</p>
            {affectedConnectionCount === 0 &&
              affectedEnvironmentCount === 0 && (
                <p>{t("origins.removeConfirmNothingNote")}</p>
              )}
            {affectedConnectionCount > 0 && (
              <p>
                {t("origins.removeConfirmConnectionsNote", {
                  count: affectedConnectionCount,
                })}
              </p>
            )}
            {affectedEnvironmentCount > 0 && (
              <p>
                {t("origins.removeConfirmEnvironmentsNote", {
                  count: affectedEnvironmentCount,
                })}
              </p>
            )}
          </div>
        }
        confirmLabel={t("origins.remove")}
        confirming={removing}
        onConfirm={() => void performRemove()}
      />

      <ConfirmDialog
        open={bulkRetireOpen}
        onOpenChange={(open) => !open && setBulkRetireOpen(false)}
        title={t("origins.vanished.retireAllConfirmTitle", {
          count: vanishedIds.length,
        })}
        description={<p>{t("origins.vanished.retireAllConfirm")}</p>}
        confirmLabel={t("origins.vanished.retireAll")}
        confirming={bulkRetiring}
        onConfirm={() => void performBulkRetire()}
      />
    </div>
  );
}
