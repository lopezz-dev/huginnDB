/**
 * The policy editor's simpler panes: the document-wide settings, the users,
 * the JSON itself, and "view as". The roles pane has its own file.
 */

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Editor from "@monaco-editor/react";
import { Check, Minus, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { SearchField } from "@/components/ui/search-field";
import { Segmented } from "@/components/ui/segmented";
import { editorOptionsFromPrefs } from "@/lib/monaco/editorOptions";
import { useEditorOptions } from "@/lib/monaco/useEditorOptions";
import { useMonacoTheme } from "@/lib/monaco/useMonacoTheme";
import {
  duplicateUsers,
  normaliseUser,
  removeUser,
  roleNames,
  setUser,
  type PolicyJson,
} from "@/lib/policy/draft";
import { cn } from "@/lib/utils";
import { selectEditorPrefs, usePreferences } from "@/stores/preferences/preferences";
import type { ConnectionAccess, PolicyPreview } from "@/types";
import { Field } from "./fields";

export function GeneralPane({
  doc,
  readOnly,
  onChange,
}: {
  doc: PolicyJson;
  readOnly: boolean;
  onChange: (next: PolicyJson) => void;
}) {
  const { t } = useTranslation();
  const roles = roleNames(doc);
  return (
    <div className="grid max-w-xl gap-5">
      <Field label={t("policyEditor.general.defaultRole")} hint={t("policyEditor.general.defaultRoleHint")}>
        <NativeSelect
          size="sm"
          aria-label={t("policyEditor.general.defaultRole")}
          disabled={readOnly}
          value={doc.defaultRole ?? ""}
          onChange={(e) => onChange({ ...doc, defaultRole: e.target.value })}
        >
          {!doc.defaultRole && <option value="">—</option>}
          {roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={t("policyEditor.general.unmanaged")} hint={t("policyEditor.general.unmanagedHint")}>
        <Segmented<"deny" | "allow">
          size="sm"
          aria-label={t("policyEditor.general.unmanaged")}
          value={doc.unmanagedConnections ?? "deny"}
          onValueChange={(v) => !readOnly && onChange({ ...doc, unmanagedConnections: v })}
          options={[
            { value: "deny", label: t("policyEditor.general.unmanagedDeny") },
            { value: "allow", label: t("policyEditor.general.unmanagedAllow") },
          ]}
        />
      </Field>
      <Field label={t("policyEditor.general.version")}>
        <span className="font-mono text-xs">{doc.version ?? "—"}</span>
      </Field>
    </div>
  );
}

export function UsersPane({
  doc,
  readOnly,
  onChange,
}: {
  doc: PolicyJson;
  readOnly: boolean;
  onChange: (next: PolicyJson) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [account, setAccount] = useState("");
  const roles = roleNames(doc);
  const users = Object.entries(doc.users ?? {});
  const dupes = duplicateUsers(doc);
  const q = query.trim().toLowerCase();
  const shown = q
    ? users.filter(([u, r]) => u.toLowerCase().includes(q) || r.toLowerCase().includes(q))
    : users;
  const taken = account.trim() !== "" &&
    users.some(([u]) => normaliseUser(u) === normaliseUser(account));

  const add = () => {
    const a = account.trim();
    if (!a || taken) return;
    onChange(setUser(doc, a, doc.defaultRole ?? roles[0] ?? ""));
    setAccount("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <p className="text-2xs text-muted-foreground">{t("policyEditor.users.intro")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <SearchField
          size="sm"
          className="w-64"
          value={query}
          onValueChange={setQuery}
          onClear={() => setQuery("")}
          clearLabel={t("policyEditor.users.clearSearch")}
          placeholder={t("policyEditor.users.search")}
          aria-label={t("policyEditor.users.search")}
        />
        {!readOnly && (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Input
              size="sm"
              className="w-56 font-mono"
              aria-label={t("policyEditor.users.account")}
              placeholder={"EMPRESA\\ana.garcia"}
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            />
            <Button size="sm" variant="outline" icon={Plus} type="submit" disabled={!account.trim() || taken}>
              {t("policyEditor.users.add")}
            </Button>
          </form>
        )}
        <span className="text-3xs text-muted-foreground">
          {t("policyEditor.users.count", { count: users.length })}
        </span>
      </div>
      {taken && <p className="text-2xs text-destructive">{t("policyEditor.users.taken")}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted text-3xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">{t("policyEditor.users.account")}</th>
              <th className="px-3 py-1.5 text-left font-medium">{t("policyEditor.users.role")}</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {shown.map(([u, r]) => (
              <tr key={u} className="border-t border-border">
                <td className={cn("px-3 py-1 font-mono", dupes.has(u) && "text-destructive")}>
                  {u}
                  {dupes.has(u) && (
                    <span className="ml-2 font-sans text-3xs">{t("policyEditor.users.duplicate")}</span>
                  )}
                </td>
                <td className="px-3 py-1">
                  <NativeSelect
                    size="xs"
                    aria-label={`${t("policyEditor.users.role")}: ${u}`}
                    disabled={readOnly}
                    value={r}
                    onChange={(e) => onChange(setUser(doc, u, e.target.value))}
                  >
                    {!roles.includes(r) && <option value={r}>{r}</option>}
                    {roles.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </NativeSelect>
                </td>
                <td className="px-1 py-1">
                  {!readOnly && (
                    <IconButton
                      flat
                      size="xs"
                      icon={Trash2}
                      label={t("policyEditor.users.remove")}
                      onClick={() => onChange(removeUser(doc, u))}
                    />
                  )}
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-4 text-center text-2xs text-muted-foreground">
                  {users.length === 0 ? t("policyEditor.users.none") : t("policyEditor.users.noMatch")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The document as text. The form and this are two views of the same draft:
 *  a valid edit here shows up in the form, and while this does not parse the
 *  form is locked with the reason. */
export function JsonPane({
  text,
  readOnly,
  onChange,
}: {
  text: string;
  readOnly: boolean;
  onChange: (next: string) => void;
}) {
  const editorPrefs = usePreferences(selectEditorPrefs);
  const theme = useMonacoTheme(editorPrefs.theme);
  const options = useEditorOptions(
    () => ({
      ...editorOptionsFromPrefs(editorPrefs),
      readOnly,
      minimap: { enabled: false },
      tabSize: 2,
    }),
    [editorPrefs, readOnly],
  );
  return (
    <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border">
      <Editor
        height="100%"
        language="json"
        theme={theme}
        value={text}
        onChange={(v) => onChange(v ?? "")}
        options={options}
      />
    </div>
  );
}

function Mark({ on, label }: { on: boolean; label: string }) {
  const Icon = on ? Check : Minus;
  return (
    <span
      className={cn("inline-flex items-center gap-1", on ? "text-foreground" : "text-muted-foreground/60")}
    >
      <Icon aria-hidden className="h-3 w-3" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function verbsText(a: ConnectionAccess, none: string): string {
  // A verb limited to some columns names them: "update (estado, obs*)".
  const verbs = a.verbs.map((v) => {
    const limit = v === "insert" || v === "update" ? a.columns?.[v] : null;
    return limit ? `${v} (${limit.length > 0 ? limit.join(", ") : "—"})` : v;
  });
  const all = [...verbs, ...(a.export ? ["export"] : []), ...(a.monitor ? ["monitor"] : [])];
  return all.length > 0 ? all.join(", ") : none;
}

/**
 * "View as": what one person — and their AI — would get on each saved
 * connection under the draft, answered by the same decision the commands
 * make (`policy::editor::preview`). The last check before saving a change
 * that could lock someone out.
 */
export function PreviewPane({
  doc,
  user,
  onUserChange,
  preview,
  error,
}: {
  doc: PolicyJson;
  user: string;
  onUserChange: (user: string) => void;
  preview: PolicyPreview | null;
  error: string | null;
}) {
  const { t } = useTranslation();
  const accounts = useMemo(() => Object.keys(doc.users ?? {}), [doc.users]);
  const [other, setOther] = useState("");
  const pickOther = useCallback(() => {
    if (other.trim()) onUserChange(other.trim());
  }, [other, onUserChange]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <p className="text-2xs text-muted-foreground">{t("policyEditor.preview.intro")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          size="sm"
          aria-label={t("policyEditor.preview.user")}
          value={accounts.includes(user) ? user : ""}
          onChange={(e) => e.target.value && onUserChange(e.target.value)}
        >
          <option value="">{t("policyEditor.preview.pick")}</option>
          {accounts.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </NativeSelect>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            pickOther();
          }}
        >
          <Input
            size="sm"
            className="w-48 font-mono"
            aria-label={t("policyEditor.preview.other")}
            placeholder={t("policyEditor.preview.other")}
            value={other}
            onChange={(e) => setOther(e.target.value)}
          />
          <Button size="sm" variant="outline" type="submit" disabled={!other.trim()}>
            {t("policyEditor.preview.show")}
          </Button>
        </form>
      </div>
      {error ? (
        <p className="text-2xs text-destructive">{t("policyEditor.preview.invalid")}</p>
      ) : !user ? null : !preview ? (
        <p className="text-2xs text-muted-foreground">{t("policyEditor.preview.loading")}</p>
      ) : (
        <>
          <p className="text-xs">
            {t(preview.listed ? "policyEditor.preview.role" : "policyEditor.preview.defaultRole", {
              user: preview.user,
              role: preview.role,
            })}
          </p>
          <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted text-3xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">{t("policyEditor.preview.connection")}</th>
                  <th className="px-3 py-1.5 font-medium">{t("policyEditor.preview.reaches")}</th>
                  <th className="px-3 py-1.5 text-left font-medium">{t("settings.policy.human")}</th>
                  <th className="px-3 py-1.5 text-left font-medium">{t("settings.policy.ai")}</th>
                  <th className="px-3 py-1.5 font-medium">{t("settings.policy.freeSql")}</th>
                  <th className="px-3 py-1.5 text-left font-medium">{t("policyEditor.preview.dbUser")}</th>
                </tr>
              </thead>
              <tbody>
                {preview.connections.map((c) => (
                  <tr key={c.id} className={cn("border-t border-border", !c.human.visible && "text-muted-foreground")}>
                    <td className="px-3 py-1">{c.name}</td>
                    <td className="px-3 py-1 text-center">
                      <Mark on={c.human.visible} label={t("policyEditor.preview.reaches")} />
                    </td>
                    <td className="px-3 py-1 font-mono text-2xs">
                      {c.human.visible ? verbsText(c.human, t("settings.policy.nothing")) : "—"}
                      {!c.human.managed && c.human.visible && (
                        <span className="ml-1 font-sans text-3xs text-muted-foreground">
                          {t("policyEditor.preview.unmanaged")}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1 font-mono text-2xs">
                      {c.ai.visible ? verbsText(c.ai, t("settings.policy.nothing")) : "—"}
                    </td>
                    <td className="px-3 py-1 text-center">
                      <Mark on={c.human.freeSql} label={t("settings.policy.freeSql")} />
                    </td>
                    <td className="px-3 py-1 font-mono text-2xs">{c.dbUser ?? "—"}</td>
                  </tr>
                ))}
                {preview.connections.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-4 text-center text-2xs text-muted-foreground">
                      {t("policyEditor.preview.noConnections")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
