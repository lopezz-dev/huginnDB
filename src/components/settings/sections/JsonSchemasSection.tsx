/**
 * Settings → JSON Schemas: the canonical view of the library and the cascade.
 *
 * Layout is master-detail (library on the left, one entry on the right) with the
 * bindings table full-width underneath, plus a "test a column" box.
 *
 * # Monaco inside a Settings dialog
 *
 * It fits, and it does not need a nested dialog or a tab. The Settings
 * `DialogContent` is `h-[82vh]` with a scrollable main pane, and a 180px editor
 * with `automaticLayout` sits in it comfortably — the DDL preview pane in
 * `StructureEditorTab` is the same trick. When 180px is not enough, F11 promotes
 * it to a `fixed inset-0` overlay, exactly the pattern `SideEditorPanel` already
 * uses. That sidesteps stacking two Radix focus traps around two editors.
 *
 * The body is validated against the **bundled** draft-07 meta-schema, so
 * `type`/`properties`/`required` complete as you type with no vendored file and
 * no network request — see `lib/monaco/monacoJson.ts` for how, and for the three
 * language-service traps this surface has to explain rather than hide.
 *
 * # Why the body has an explicit Save and the name does not
 *
 * Sections in this dialog write straight through (the prefs store debounces).
 * That is right for a setting and wrong for a document: a half-typed schema
 * saving on every keystroke would flood the change broadcast and make every
 * window revalidate. Name and description debounce like a setting; the body is
 * committed deliberately.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Editor from "@monaco-editor/react";
import {
  Braces,
  Copy,
  Download,
  FileJson,
  Maximize2,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { notify } from "@/lib/notify";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { PrefGroup } from "@/components/settings/sections/PrefGroup";
import { PrefRow } from "@/components/settings/sections/PrefRow";
import { CONTROL_FOCUS_TIGHT } from "@/components/ui/styles";
import { Switch } from "@/components/ui/switch";
import { BindingsTable } from "@/components/jsonSchema/BindingsTable";
import { BindingScopeFields } from "@/components/jsonSchema/BindingScopeFields";
import { useJsonSchemas } from "@/stores/jsonSchemas";
import { useJsonSchemaTransfer } from "@/stores/dialogs/jsonSchemaTransfer";
import {
  usePreferences,
  selectEditorPrefs,
} from "@/stores/preferences/preferences";
import { useMonacoTheme } from "@/lib/monaco/useMonacoTheme";
import { schemaModelPath, collectExternalRefs } from "@/lib/monaco/monacoJson";
import { schemaUri } from "@/stores/jsonSchemas";
import { SCHEMA_TEMPLATES } from "@/lib/jsonSchema/templates";
import { tryFormat } from "@/lib/grid/detectContentType";
import { confirmIrreversible } from "@/lib/confirmDestructive";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { JsonSchemaBinding, JsonSchemaMatch } from "@/types";
import { pickJsonFile } from "@/lib/dialogs";
import { editorOptionsFromPrefs } from "@/lib/monaco/editorOptions";
import { useEditorOptions } from "@/lib/monaco/useEditorOptions";
import { EditorContextMenu, useMenuEditor } from "@/components/menus/EditorContextMenu";

export function JsonSchemasSection() {
  const { t } = useTranslation();
  const schemas = useJsonSchemas((s) => s.schemas);
  const bindings = useJsonSchemas((s) => s.bindings);
  const parseErrors = useJsonSchemas((s) => s.parseErrors);
  const saveSchema = useJsonSchemas((s) => s.saveSchema);
  const deleteSchema = useJsonSchemas((s) => s.deleteSchema);
  const editorPrefs = usePreferences(selectEditorPrefs);
  // Resolved through the hook, not the bare function: an imported
  // theme's definition arrives after first paint, and only a store
  // subscription repaints this editor when it does.
  const monacoTheme = useMonacoTheme(editorPrefs.theme);
  const openExport = useJsonSchemaTransfer((s) => s.openExport);
  const setImportOpen = useJsonSchemaTransfer((s) => s.setImportOpen);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [body, setBody] = useState("");
  const [bodyDirty, setBodyDirty] = useState(false);
  // Name and description are edited locally and flushed on a timer, the same
  // 400 ms the preferences store uses. Without this every keystroke is an IPC
  // round trip plus a disk write plus a change broadcast to every window.
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [editingBinding, setEditingBinding] =
    useState<JsonSchemaBinding | null>(null);

  const selected = useMemo(
    () => schemas.find((s) => s.id === selectedId) ?? null,
    [schemas, selectedId],
  );

  // Keep a selection if there is anything to select; drop it when the entry goes.
  useEffect(() => {
    if (schemas.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !schemas.some((s) => s.id === selectedId)) {
      setSelectedId(schemas[0].id);
    }
  }, [schemas, selectedId]);

  // Load the fields when the selection changes, not on every render — otherwise an
  // in-progress edit would be reverted by the store refresh its own save causes.
  useEffect(() => {
    setBody(selected?.body ?? "");
    setBodyDirty(false);
    setName(selected?.name ?? "");
    setDescription(selected?.description ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  // Flush a debounced name/description edit. Guarded on an actual difference so
  // merely selecting an entry never writes.
  useEffect(() => {
    if (!selected) return;
    const trimmed = name.trim();
    const nextDescription = description.trim() || null;
    if (
      (trimmed === selected.name || !trimmed) &&
      nextDescription === (selected.description ?? null)
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      void saveSchema({
        id: selected.id,
        name: trimmed || selected.name,
        description: nextDescription,
        body: selected.body,
      });
    }, 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, description, selected?.id, selected?.name, selected?.description]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return schemas;
    return schemas.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q),
    );
  }, [schemas, filter]);

  const bindingCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of bindings) {
      counts.set(b.schemaId, (counts.get(b.schemaId) ?? 0) + 1);
    }
    return counts;
  }, [bindings]);

  const knownUris = useMemo(
    () => new Set(schemas.map((s) => schemaUri(s.id))),
    [schemas],
  );

  // An unresolvable `$ref` does not merely warn: the worker reports it and then
  // skips schema validation of the whole document, so the schema silently does
  // nothing. That has to be said out loud.
  const externalRefs = useMemo(() => {
    try {
      return collectExternalRefs(JSON.parse(body), knownUris);
    } catch {
      return [];
    }
  }, [body, knownUris]);

  const bodyError = useMemo(() => {
    if (!body.trim()) return null;
    try {
      JSON.parse(body);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [body]);

  // `newName` rather than `name`: the outer `name` is the debounced edit buffer for
  // the *selected* entry, and shadowing it here would read as a bug.
  async function createFrom(newName: string, newBody: string) {
    const saved = await saveSchema({
      name: newName,
      body: newBody,
      source: "manual",
    });
    setSelectedId(saved.id);
  }

  async function commitBody() {
    if (!selected) return;
    try {
      await saveSchema({
        id: selected.id,
        // The locally-edited name, so an in-flight rename is not lost by saving
        // the body first.
        name: name.trim() || selected.name,
        description: description.trim() || null,
        body,
      });
      setBodyDirty(false);
      notify.success(t("jsonSchemas.detail.bodySaved"));
    } catch (e) {
      notify.error(t("jsonSchemas.toast.saveFailed", { message: String(e) }));
    }
  }

  async function importFromFile() {
    const picked = await pickJsonFile(
      t("jsonSchemas.library.addFromFileTitle"),
      ["json", "schema.json"],
    );
    if (!picked) return;
    try {
      const text = await api.readTextFile(picked);
      // Validate here rather than at save time so a wrong file is rejected with a
      // useful message instead of landing as a broken library entry.
      JSON.parse(text);
      const base =
        picked
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.schema\.json$|\.json$/i, "") || "schema";
      await createFrom(base, text);
      notify.success(t("jsonSchemas.toast.created", { name: base }));
    } catch (e) {
      notify.error(
        t("jsonSchemas.library.fileNotJson", { message: String(e) }),
      );
    }
  }

  async function removeSelected() {
    if (!selected) return;
    const count = bindingCounts.get(selected.id) ?? 0;
    const message =
      count > 0
        ? t("jsonSchemas.deleteConfirmBound", { name: selected.name, count })
        : t("jsonSchemas.deleteConfirm", { name: selected.name });
    if (!(await confirmIrreversible(message))) return;
    const dropped = await deleteSchema(selected.id);
    notify.success(
      dropped > 0
        ? t("jsonSchemas.toast.deletedWithBindings", {
            name: selected.name,
            count: dropped,
          })
        : t("jsonSchemas.toast.deleted", { name: selected.name }),
    );
  }

  const handleBodyChange = useCallback((v: string | undefined) => {
    setBody(v ?? "");
    setBodyDirty(true);
  }, []);
  /** The Format button and the editor menu's Format. */
  const formatBody = () => {
    setBody(tryFormat(body, "json"));
    setBodyDirty(true);
  };
  const [menuEditor, attachMenuEditor] = useMenuEditor();
  const bodyEditorOptions = useEditorOptions(
    () => ({
      ...editorOptionsFromPrefs(editorPrefs),
      // A schema body is a document the user navigates, so folding is on;
      // the pane is too narrow for a minimap.
      minimap: { enabled: false },
      folding: true,
    }),
    [editorPrefs],
  );

  return (
    <div className="space-y-5">
      {/* The title comes from the dialog's section header; this keeps only
          the explanation, which says more than the rail's one-liner. */}
      <p className="text-xs text-muted-foreground">
        {t("jsonSchemas.description")}
      </p>

      <PrefGroup
        title={t("jsonSchemas.library.title")}
        action={
          <>
            <Button
              size="xs"
              variant="outline"
              icon={Plus}
              onClick={() =>
                void createFrom(
                  t("jsonSchemas.library.defaultName"),
                  SCHEMA_TEMPLATES[0].body,
                )
              }
            >
              {t("jsonSchemas.library.new")}
            </Button>
            <Button
              size="xs"
              variant="outline"
              icon={FileJson}
              onClick={() => void importFromFile()}
            >
              {t("jsonSchemas.library.addFromFile")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              icon={Download}
              disabled={schemas.length === 0}
              onClick={() => openExport()}
            >
              {t("transfer.exportJsonSchemas.title")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              icon={Upload}
              onClick={() => setImportOpen(true)}
            >
              {t("transfer.importJsonSchemas.title")}
            </Button>
          </>
        }
        padded={schemas.length === 0}
        bodyClassName={
          schemas.length === 0 ? undefined : "grid min-h-0 grid-cols-[200px_1fr]"
        }
      >
        {schemas.length === 0 ? (
          <EmptyLibrary
            onPick={(name, tplBody) => void createFrom(name, tplBody)}
          />
        ) : (
          <>
            <aside className="space-y-1 border-r border-border/60 p-2">
              {schemas.length > 6 && (
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t("jsonSchemas.library.filterPlaceholder")}
                  className="h-7 text-xs"
                />
              )}
              <div className="space-y-0.5">
                {visible.map((s) => {
                  const count = bindingCounts.get(s.id) ?? 0;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setSelectedId(s.id)}
                      aria-current={s.id === selectedId ? "true" : undefined}
                      className={cn(
                        // The rail's pill, so "selected" reads the same here as
                        // in the dialog's own navigation.
                        "flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left leading-tight transition-colors",
                        CONTROL_FOCUS_TIGHT,
                        s.id === selectedId
                          ? "bg-brand/10 font-medium"
                          : "hover:bg-accent",
                      )}
                    >
                      <span className="flex w-full items-center gap-1 text-xs">
                        <span className="truncate">{s.name}</span>
                        {parseErrors[s.id] && (
                          <span
                            className="shrink-0 text-warning"
                            title={t("jsonSchemas.library.invalidBody")}
                          >
                            ⚠
                          </span>
                        )}
                      </span>
                      <span className="text-3xs text-muted-foreground">
                        {count > 0
                          ? t("jsonSchemas.library.bindingCount", { count })
                          : t("jsonSchemas.library.unbound")}
                      </span>
                    </button>
                  );
                })}
                {visible.length === 0 && (
                  <p className="px-2 py-1 text-2xs text-muted-foreground">
                    {t("jsonSchemas.library.noMatches")}
                  </p>
                )}
              </div>
            </aside>

            <div className="min-w-0 space-y-2 p-4">
              {!selected ? (
                <p className="text-xs text-muted-foreground">
                  {t("jsonSchemas.detail.selectPrompt")}
                </p>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="h-7 text-xs"
                      placeholder={t("jsonSchemas.detail.namePlaceholder")}
                    />
                    <IconButton
                      icon={Copy}
                      label={t("jsonSchemas.detail.duplicate")}
                      className="shrink-0"
                      onClick={() =>
                        void createFrom(`${selected.name} (copy)`, selected.body)
                      }
                    />
                    <IconButton
                      icon={Trash2}
                      tone="destructive"
                      label={t("jsonSchemas.detail.delete")}
                      className="shrink-0"
                      onClick={() => void removeSelected()}
                    />
                  </div>
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="h-7 text-xs"
                    placeholder={t("jsonSchemas.detail.descriptionPlaceholder")}
                  />

                  <div
                    className={cn(
                      "space-y-1",
                      fullscreen &&
                        "fixed inset-0 z-50 flex flex-col bg-background p-4",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-2xs font-medium text-muted-foreground">
                        {t("jsonSchemas.detail.body")}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={formatBody}
                      >
                        {t("jsonSchemas.detail.format")}
                      </Button>
                      <IconButton
                        icon={Maximize2}
                        label={
                          fullscreen
                            ? t("jsonSchemas.detail.exitFullscreen")
                            : t("jsonSchemas.detail.fullscreen")
                        }
                        onClick={() => setFullscreen((v) => !v)}
                      />
                      <div className="ml-auto flex items-center gap-2">
                        {bodyDirty && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setBody(selected.body);
                              setBodyDirty(false);
                            }}
                          >
                            {t("jsonSchemas.detail.revert")}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          disabled={!bodyDirty}
                          onClick={() => void commitBody()}
                        >
                          {t("jsonSchemas.detail.saveBody")}
                        </Button>
                      </div>
                    </div>

                    <EditorContextMenu
                      className={cn(
                        "overflow-hidden rounded-md border border-border",
                        fullscreen ? "min-h-0 flex-1" : "h-[180px]",
                      )}
                      editor={menuEditor}
                      header={{ title: selected.name }}
                      width="sm"
                      format={{ run: formatBody }}
                    >
                      <Editor
                        height="100%"
                        // A stable, suffixed path is what lets the bundled
                        // draft-07 meta-schema attach by `fileMatch`.
                        path={schemaModelPath(selected.id)}
                        language="json"
                        theme={monacoTheme}
                        value={body}
                        onChange={handleBodyChange}
                        onMount={attachMenuEditor}
                        options={bodyEditorOptions}
                      />
                    </EditorContextMenu>

                    {bodyError && (
                      <p className="text-2xs text-destructive">
                        {t("jsonSchemas.detail.bodyInvalid", {
                          message: bodyError,
                        })}
                      </p>
                    )}
                    {externalRefs.length > 0 && (
                      <p className="text-2xs text-warning">
                        {t("jsonSchemas.detail.externalRefs", {
                          refs: externalRefs.join(", "),
                        })}
                      </p>
                    )}
                    {!body.includes("$schema") && body.trim() && (
                      <p className="text-2xs text-muted-foreground">
                        {t("jsonSchemas.detail.noDraftDeclared")}
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </PrefGroup>

      <PrefGroup
        title={t("jsonSchemas.bindings.title")}
        description={t("jsonSchemas.bindings.cascadeHint")}
        action={
          <Button
            size="xs"
            variant="outline"
            icon={Plus}
            disabled={schemas.length === 0}
            onClick={() =>
              setEditingBinding({
                id: "",
                schemaId: selected?.id ?? schemas[0]?.id ?? "",
                connectionId: null,
                dbSchema: null,
                table: null,
                column: "",
                enabled: true,
                order: 0,
                originId: null,
              })
            }
          >
            {t("jsonSchemas.bindings.new")}
          </Button>
        }
      >
        <BindingsTable onEdit={setEditingBinding} />
        {editingBinding && (
          <BindingScopeFields
            binding={editingBinding}
            onClose={() => setEditingBinding(null)}
          />
        )}
      </PrefGroup>

      <TestColumnBox />

      <BehaviourPrefs />
    </div>
  );
}

/** The empty state. Templates rather than a blank buffer — see
 *  `lib/jsonSchema/templates.ts` for why. */
function EmptyLibrary({
  onPick,
}: {
  onPick: (name: string, body: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("jsonSchemas.empty.title")}</p>
        <p className="text-xs text-muted-foreground">
          {t("jsonSchemas.empty.body")}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {SCHEMA_TEMPLATES.map((tpl) => (
          <button
            key={tpl.id}
            type="button"
            onClick={() => onPick(t(tpl.nameKey), tpl.body)}
            className="rounded-md border border-border bg-background/60 px-2.5 py-2 text-left transition-colors hover:bg-accent"
          >
            <span className="flex items-center gap-1 text-xs font-medium">
              <Braces className="h-3 w-3 shrink-0" />
              {t(tpl.nameKey)}
            </span>
            <span className="mt-0.5 block text-3xs leading-snug text-muted-foreground">
              {t(tpl.descKey)}
            </span>
          </button>
        ))}
      </div>
      <p className="text-2xs text-muted-foreground">
        {t("jsonSchemas.empty.orImport")}
      </p>
    </div>
  );
}

/**
 * "Which schema does this column resolve to?"
 *
 * Answers the question this feature will generate most — *why is my rule not
 * applying?* — using the one resolver, so the answer can never disagree with what
 * the editor does. A live match counter was the alternative and is worse: it would
 * have to walk the catalogues of every live connection, which is expensive and
 * still only covers what happens to be connected.
 */
function TestColumnBox() {
  const { t } = useTranslation();
  const [probe, setProbe] = useState("");
  const [result, setResult] = useState<JsonSchemaMatch[] | null>(null);

  async function run() {
    // `schema.table.column`, from the right: the column is the last segment, so a
    // bare `column` and a fully-qualified path both work.
    const parts = probe.split(".").filter(Boolean);
    if (parts.length === 0) return;
    const column = parts.pop() as string;
    const table = parts.pop() ?? null;
    const dbSchema = parts.pop() ?? null;
    try {
      const matches = await api.explainJsonSchemaBindings({
        connectionId: null,
        dbSchema,
        table,
        column,
      });
      setResult(matches);
    } catch {
      setResult([]);
    }
  }

  return (
    <PrefGroup
      title={t("jsonSchemas.test.title")}
      description={t("jsonSchemas.test.hint")}
      padded
    >
      <div className="flex items-center gap-2">
        <Input
          value={probe}
          onChange={(e) => setProbe(e.target.value)}
          placeholder={t("jsonSchemas.test.placeholder")}
          className="h-7 max-w-xs font-mono text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
        />
        <Button size="sm" variant="outline" onClick={() => void run()}>
          {t("jsonSchemas.test.run")}
        </Button>
      </div>
      {result !== null && (
        <p className="font-mono text-2xs">
          {result.length === 0 ? (
            <span className="text-muted-foreground">
              {t("jsonSchemas.test.noMatch")}
            </span>
          ) : (
            <span className="text-brand">
              {t("jsonSchemas.test.match", {
                name: result[0].schemaName,
                rank: result[0].rank,
              })}
            </span>
          )}
        </p>
      )}
    </PrefGroup>
  );
}

/**
 * The three behaviour toggles.
 *
 * They live here rather than under Editor for the same reason
 * `AppearanceSection` hosts the data-view group: they answer the question *this*
 * section is about ("what does the attached schema do?"). They are split into
 * three because Monaco splits them — a loose schema is useful for completion long
 * before anyone wants red squiggles.
 */
function BehaviourPrefs() {
  const { t } = useTranslation();
  const prefs = usePreferences((s) => s.prefs);
  const updateEditor = usePreferences((s) => s.updateEditor);
  return (
    <PrefGroup title={t("jsonSchemas.prefs.title")}>
      <PrefRow
        prefId="editor.jsonSchemaValidation"
        label={t("jsonSchemas.prefs.validation.label")}
        description={t("jsonSchemas.prefs.validation.desc")}
      >
        <Switch
          checked={prefs.editor.jsonSchemaValidation}
          onCheckedChange={(v) => updateEditor({ jsonSchemaValidation: v })}
        />
      </PrefRow>
      <PrefRow
        prefId="editor.jsonSchemaCompletion"
        label={t("jsonSchemas.prefs.completion.label")}
        description={t("jsonSchemas.prefs.completion.desc")}
      >
        <Switch
          checked={prefs.editor.jsonSchemaCompletion}
          onCheckedChange={(v) => updateEditor({ jsonSchemaCompletion: v })}
        />
      </PrefRow>
      <PrefRow
        prefId="editor.jsonSchemaHover"
        label={t("jsonSchemas.prefs.hover.label")}
        description={t("jsonSchemas.prefs.hover.desc")}
      >
        <Switch
          checked={prefs.editor.jsonSchemaHover}
          onCheckedChange={(v) => updateEditor({ jsonSchemaHover: v })}
        />
      </PrefRow>
    </PrefGroup>
  );
}
