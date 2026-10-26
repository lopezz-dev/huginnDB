/**
 * Settings → Policy → "Edit policy" / "Create policy": the managed policy,
 * edited as a form and as JSON — phase 4 of managed policy
 * (`policy::editor`, ADR #99).
 *
 * Who may save is decided by the share: the backend saves only where a real
 * write to the file's folder succeeds, and says why when it does not. There
 * is no "administrator" here to check.
 *
 * **The draft is text.** `text` is the one source of truth; the form panes
 * edit the object it parses to and write it back formatted, and the JSON pane
 * edits the text itself. While the text does not parse, the form is locked
 * with the reason instead of guessing what was meant. Every draft is checked
 * by the parser that applies the policy (`policy_validate`, debounced), which
 * is also what the save refuses to skip.
 *
 * Mounted in `App` by `PolicyEditorHost`, as a sibling of Settings rather than
 * inside Settings → Policy: two stacked workbenches trap focus in whichever
 * mounted last. Opening it puts Settings aside and closing it gives Settings
 * back on the Policy section (`stores/dialogs/policyEditor.ts`).
 *
 * Same skeleton as the shared-origin editor (`OriginEditorOverlay`): a
 * `workbench` dialog, a rail of panes, the draft local to the dialog, a
 * confirmation that says what changes, and a conflict that keeps the user's
 * text on the clipboard instead of losing it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Braces,
  Copy,
  Eye,
  FolderOpen,
  Lock,
  Settings2,
  ShieldCheck,
  Users,
} from "lucide-react";

import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NavRailItem } from "@/components/ui/nav-rail";
import { Spinner } from "@/components/ui/spinner";
import { RolesPane } from "@/components/settings/policyEditor/RolesPane";
import {
  GeneralPane,
  JsonPane,
  PreviewPane,
  UsersPane,
} from "@/components/settings/policyEditor/panes";
import { copyToClipboard } from "@/lib/clipboard";
import { notify } from "@/lib/notify";
import {
  formatDraft,
  parseDraft,
  roleOf,
  summarizeChanges,
  templatePolicy,
  type PolicyJson,
} from "@/lib/policy/draft";
import { api } from "@/lib/tauri";
import { useDebouncedPreview } from "@/lib/useDebouncedPreview";
import { usePolicyEditor } from "@/stores/dialogs/policyEditor";
import { cn } from "@/lib/utils";
import type {
  CreatedPolicy,
  PolicyDraftCheck,
  PolicyEditDoc,
  PolicyStatus,
} from "@/types";

type Pane = "general" | "roles" | "users" | "json" | "preview";
const PANES: { id: Pane; icon: typeof Users }[] = [
  { id: "roles", icon: ShieldCheck },
  { id: "users", icon: Users },
  { id: "general", icon: Settings2 },
  { id: "preview", icon: Eye },
  { id: "json", icon: Braces },
];

/** The editor as `App` mounts it: open while `usePolicyEditor` holds a status. */
export function PolicyEditorHost() {
  const status = usePolicyEditor((s) => s.status);
  const close = usePolicyEditor((s) => s.close);
  if (!status) return null;
  return <PolicyEditorDialog open status={status} onOpenChange={(next) => !next && close()} />;
}

export function PolicyEditorDialog({
  open,
  onOpenChange,
  status,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** For the current account (the template's author, "your role changes"). */
  status: PolicyStatus;
  /** After a save or a create. Optional: Settings → Policy re-reads the
   *  status anyway when it comes back (`usePolicyEditor.close`). */
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const [doc, setDoc] = useState<PolicyEditDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [pristine, setPristine] = useState("");
  const [pane, setPane] = useState<Pane>("roles");
  const [check, setCheck] = useState<PolicyDraftCheck | null>(null);
  const [previewUser, setPreviewUser] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [createPath, setCreatePath] = useState("");
  const [created, setCreated] = useState<CreatedPolicy | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    setStale(false);
    try {
      const d = await api.policyOpenForEdit();
      setDoc(d);
      // No policy yet: start from the template. An inline policy (registry,
      // Program Files) starts from its own text, to be exported to a file.
      const start =
        d.anchor.kind === "none" && !d.text.trim()
          ? formatDraft(templatePolicy(status.user))
          : d.text;
      setText(start);
      setPristine(d.anchor.kind === "file" ? d.text : "");
    } catch (e) {
      setLoadError(String(e));
    }
  }, [status.user]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const creating = doc !== null && doc.anchor.kind !== "file";
  const parsed = useMemo(() => parseDraft(text), [text]);
  const readOnly =
    !doc ||
    stale ||
    (!creating && !(doc.writable?.writable ?? false));
  const dirty = creating ? text.trim() !== "" : text !== pristine;
  const validationError = !parsed.ok ? parsed.error : (check?.validation.error ?? null);

  const runCheck = useCallback(() => {
    if (!text.trim()) {
      setCheck(null);
      return;
    }
    api
      .policyValidate(text, pane === "preview" ? previewUser || null : null)
      .then(setCheck)
      .catch(() => setCheck(null));
  }, [text, pane, previewUser]);
  useDebouncedPreview(`${text}\u0000${pane}\u0000${previewUser}`, runCheck);

  const setDoc_ = (next: PolicyJson) => setText(formatDraft(next));

  const before = useMemo<PolicyJson>(() => {
    const p = parseDraft(pristine);
    return p.ok ? p.doc : {};
  }, [pristine]);
  const changes = parsed.ok ? summarizeChanges(before, parsed.doc) : null;
  const myRoleBefore = roleOf(before, status.user);
  const myRoleAfter = parsed.ok ? roleOf(parsed.doc, status.user) : undefined;

  async function save() {
    if (!doc) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (creating) {
        const result = await api.policyCreate(createPath, text);
        setCreated(result);
        setConfirming(false);
        onSaved?.();
        return;
      }
      const outcome = await api.policySave(text, doc.base?.sha256 ?? "");
      if (outcome.status === "conflict") {
        // Somebody else saved first. Their file wins the screen; the user's
        // text goes to the clipboard so nothing typed is lost.
        await copyToClipboard(text).catch(() => {});
        setStale(true);
        setConfirming(false);
        notify.error(t("policyEditor.conflict.title"), {
          description: t("policyEditor.conflict.copied"),
        });
        return;
      }
      setConfirming(false);
      notify.success(t("policyEditor.saved"), {
        description: outcome.backup ? t("policyEditor.savedBackup") : undefined,
      });
      onSaved?.();
      await load();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function pickPath() {
    const path = await saveFileDialog({
      defaultPath: "huginn-policy.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    }).catch(() => null);
    if (path) setCreatePath(path);
  }

  const header = doc && (
    <DialogHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
      <div className="min-w-0 flex-1 space-y-1">
        <DialogTitle>
          {creating
            ? doc.anchor.kind === "none"
              ? t("policyEditor.titleCreate")
              : t("policyEditor.titleExport")
            : t("policyEditor.title")}
        </DialogTitle>
        <DialogDescription className={cn("text-2xs", !creating && "font-mono")}>
          {creating
            ? t(doc.anchor.kind === "none" ? "policyEditor.createIntro" : "policyEditor.exportIntro", {
                origin: doc.anchor.origin ?? "",
              })
            : doc.anchor.path}
        </DialogDescription>
        {!creating && doc.writable && !doc.writable.writable && (
          <p className="mt-1 flex items-center gap-1 text-2xs text-muted-foreground">
            <Lock aria-hidden className="h-3 w-3 shrink-0" />
            {t("policyEditor.notWritable", { reason: doc.writable.reason ?? "" })}
          </p>
        )}
        {stale && (
          <p className="mt-1 flex items-center gap-1 text-2xs text-destructive">
            <AlertTriangle aria-hidden className="h-3 w-3 shrink-0" />
            {t("policyEditor.conflict.banner")}
            <Button variant="link" size="xs" className="h-auto p-0 text-2xs" onClick={() => void load()}>
              {t("policyEditor.conflict.reload")}
            </Button>
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {!creating && dirty && !readOnly && (
          <Button variant="ghost" size="sm" onClick={() => setText(pristine)}>
            {t("policyEditor.discard")}
          </Button>
        )}
        <Button
          size="sm"
          disabled={
            readOnly ||
            !dirty ||
            !!validationError ||
            (creating && !createPath.trim())
          }
          onClick={() => {
            setSaveError(null);
            setConfirming(true);
          }}
        >
          {creating ? t("policyEditor.create") : t("policyEditor.save")}
        </Button>
      </div>
    </DialogHeader>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent tier="workbench" className="flex h-[92vh] max-w-[min(1400px,95vw)] flex-col">
        {!doc && !loadError ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner size="lg" className="text-muted-foreground" />
          </div>
        ) : loadError ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-destructive">
            {loadError}
          </div>
        ) : doc && created ? (
          <CreatedView created={created} onClose={() => onOpenChange(false)} />
        ) : doc ? (
          <>
            {header}
            {creating && (
              <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-5 py-2 text-xs">
                <span className="text-muted-foreground">{t("policyEditor.createPath")}</span>
                <Input
                  size="sm"
                  className="min-w-0 flex-1 font-mono"
                  aria-label={t("policyEditor.createPath")}
                  placeholder={"\\\\srv-ficheros\\huginndb\\huginn-policy.json"}
                  value={createPath}
                  onChange={(e) => setCreatePath(e.target.value)}
                />
                <Button size="sm" variant="outline" icon={FolderOpen} onClick={() => void pickPath()}>
                  {t("policyEditor.browse")}
                </Button>
              </div>
            )}
            {doc.readError && (
              <p className="border-b border-border px-5 py-2 text-2xs text-destructive">{doc.readError}</p>
            )}
            <div className="grid min-h-0 flex-1 grid-cols-[200px_1fr] overflow-hidden">
              <aside className="space-y-0.5 overflow-y-auto border-r border-border bg-card/40 p-2">
                {PANES.map((p) => (
                  <NavRailItem
                    key={p.id}
                    icon={p.icon}
                    active={p.id === pane}
                    label={t(`policyEditor.panes.${p.id}.label`)}
                    description={t(`policyEditor.panes.${p.id}.desc`)}
                    onClick={() => setPane(p.id)}
                  />
                ))}
              </aside>
              <main className="flex min-h-0 flex-col gap-3 overflow-hidden px-5 py-4">
                {validationError && (
                  <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-2xs text-destructive">
                    <b className="mr-1">{t("policyEditor.invalid")}</b>
                    <span className="font-mono">{validationError}</span>
                  </div>
                )}
                {!validationError && (check?.validation.warnings.length ?? 0) > 0 && (
                  <ul className="list-disc rounded-md border border-border bg-muted/40 py-2 pl-7 pr-3 text-2xs text-muted-foreground">
                    {check!.validation.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}
                {pane === "json" ? (
                  <JsonPane text={text} readOnly={readOnly} onChange={setText} />
                ) : !parsed.ok ? (
                  <p className="text-2xs text-muted-foreground">{t("policyEditor.fixJsonFirst")}</p>
                ) : pane === "roles" ? (
                  <RolesPane
                    doc={parsed.doc}
                    exampleUser={status.user || "ana.garcia"}
                    readOnly={readOnly}
                    onChange={setDoc_}
                  />
                ) : pane === "users" ? (
                  <UsersPane doc={parsed.doc} readOnly={readOnly} onChange={setDoc_} />
                ) : pane === "general" ? (
                  <div className="min-h-0 overflow-y-auto">
                    <GeneralPane doc={parsed.doc} readOnly={readOnly} onChange={setDoc_} />
                  </div>
                ) : (
                  <PreviewPane
                    doc={parsed.doc}
                    user={previewUser}
                    onUserChange={setPreviewUser}
                    preview={check?.preview ?? null}
                    error={validationError}
                  />
                )}
              </main>
            </div>

            <ConfirmDialog
              open={confirming}
              onOpenChange={(next) => !next && setConfirming(false)}
              title={creating ? t("policyEditor.confirmCreateTitle") : t("policyEditor.confirmTitle")}
              description={
                creating
                  ? t("policyEditor.confirmCreateBody", { path: createPath })
                  : t("policyEditor.confirmBody")
              }
              confirmLabel={creating ? t("policyEditor.create") : t("policyEditor.save")}
              confirming={saving}
              error={saveError}
              onConfirm={() => void save()}
            >
              {changes && !creating && <ChangeSummary changes={changes} />}
              <ul className="mt-2 list-disc space-y-1 pl-4 text-2xs text-muted-foreground">
                {changes?.dbUserIntroduced && (
                  <li className="text-warning">{t("policyEditor.warn.dbUser")}</li>
                )}
                {changes?.columnsIntroduced && (
                  <li className="text-warning">{t("policyEditor.warn.columns")}</li>
                )}
                {!creating && myRoleBefore !== myRoleAfter && (
                  <li className="text-warning">
                    {t("policyEditor.warn.ownRole", {
                      from: myRoleBefore ?? "—",
                      to: myRoleAfter ?? "—",
                    })}
                  </li>
                )}
                <li>{t("policyEditor.warn.appliesSoon")}</li>
              </ul>
            </ConfirmDialog>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ChangeSummary({ changes }: { changes: ReturnType<typeof summarizeChanges> }) {
  const { t } = useTranslation();
  const rows: [string, string][] = [];
  const list = (xs: string[]) => xs.join(", ");
  if (changes.rolesAdded.length) rows.push([t("policyEditor.change.rolesAdded"), list(changes.rolesAdded)]);
  if (changes.rolesRemoved.length) rows.push([t("policyEditor.change.rolesRemoved"), list(changes.rolesRemoved)]);
  if (changes.rulesChanged.length) rows.push([t("policyEditor.change.rulesChanged"), list(changes.rulesChanged)]);
  if (changes.usersAdded.length) rows.push([t("policyEditor.change.usersAdded"), list(changes.usersAdded)]);
  if (changes.usersRemoved.length) rows.push([t("policyEditor.change.usersRemoved"), list(changes.usersRemoved)]);
  for (const m of changes.usersMoved) {
    rows.push([m.user, `${m.from} → ${m.to}`]);
  }
  if (changes.defaultRole) {
    rows.push([
      t("policyEditor.general.defaultRole"),
      `${changes.defaultRole.from ?? "—"} → ${changes.defaultRole.to ?? "—"}`,
    ]);
  }
  if (changes.unmanaged) {
    rows.push([
      t("policyEditor.general.unmanaged"),
      `${changes.unmanaged.from ?? "deny"} → ${changes.unmanaged.to ?? "deny"}`,
    ]);
  }
  if (rows.length === 0) {
    return <p className="mt-2 text-2xs text-muted-foreground">{t("policyEditor.change.formatOnly")}</p>;
  }
  return (
    <dl className="mt-2 grid max-h-48 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 overflow-y-auto rounded-md bg-muted/40 px-3 py-2 text-2xs">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="font-mono">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function CreatedView({ created, onClose }: { created: CreatedPolicy; onClose: () => void }) {
  const { t } = useTranslation();
  const copy = (s: string) =>
    void copyToClipboard(s).then(() => notify.success(t("policyEditor.createdCopied")));
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4 p-6 text-sm">
      <DialogHeader>
        <DialogTitle>{t("policyEditor.createdTitle")}</DialogTitle>
        <DialogDescription>{t("policyEditor.createdBody", { path: created.path })}</DialogDescription>
      </DialogHeader>
      {created.warnings.map((w) => (
        <p key={w} className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-2xs">
          <AlertTriangle aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
          {w}
        </p>
      ))}
      <div className="grid gap-1">
        <span className="text-2xs font-medium text-muted-foreground">{t("policyEditor.createdOneMachine")}</span>
        <div className="flex items-start gap-2">
          <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-2xs">
            {created.regCommand}
          </pre>
          <Button size="sm" variant="outline" icon={Copy} onClick={() => copy(created.regCommand)}>
            {t("policyEditor.copy")}
          </Button>
        </div>
      </div>
      <div className="grid gap-1">
        <span className="text-2xs font-medium text-muted-foreground">{t("policyEditor.createdGpo")}</span>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border bg-muted/40 p-3 font-mono text-2xs">
          <dt className="font-sans text-muted-foreground">{t("policyEditor.createdKey")}</dt>
          <dd>{created.registryKey}</dd>
          <dt className="font-sans text-muted-foreground">{t("policyEditor.createdValue")}</dt>
          <dd>{created.registryValue} (REG_SZ)</dd>
          <dt className="font-sans text-muted-foreground">{t("policyEditor.createdData")}</dt>
          <dd className="break-all">{created.path}</dd>
        </dl>
      </div>
      <div className="flex justify-end">
        <Button onClick={onClose}>{t("common.close")}</Button>
      </div>
    </div>
  );
}
