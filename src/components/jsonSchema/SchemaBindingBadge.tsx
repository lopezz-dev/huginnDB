/**
 * The "which JSON Schema applies to this cell" chip, and the dropdown that
 * changes the answer.
 *
 * This is the universal surface for the feature: it works on every driver,
 * including MongoDB, where the structure editor is read-only (per
 * `supportsStructureEditing`), and it sits where the pain is — inside the
 * editor, next to the JSON-valid chip.
 *
 * Three things it deliberately does NOT do:
 *
 * * **It never blocks a save.** Nothing in the save path reads markers, and the
 *   diagnostics are configured at warning severity so a violation does not even
 *   *look* like it blocks. The database is the authority; the schema is an aid.
 * * **It never calls `window.confirm`.** It can render inside `SideEditorPanel`,
 *   where the Tauri webview blocks that dialog. Nothing here is irreversible
 *   anyway: linking is one click to undo, and no schema body is ever destroyed.
 * * **It offers "unlink" only when the winning rule names this exact column.**
 *   When the schema arrived through a broader rule, unlinking would delete a rule
 *   that affects other columns; the entry becomes "edit this rule in Settings"
 *   instead. (A negative binding — "here, none" — is a separate feature.)
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileJson, Pencil, Settings2, Sparkles, X } from "lucide-react";
import { notify } from "@/lib/notify";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { buttonVariants } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { InferSchemaDialog } from "@/components/jsonSchema/dialogs/InferSchemaDialog";
import {
  useJsonSchemas,
  draftBinding,
  relationKey,
} from "@/stores/jsonSchemas";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { declaresOwnSchema } from "@/lib/monaco/monacoJson";
import { formatScopeLabel } from "@/lib/jsonSchema/scopeLabel";
import type { CellBindingContext } from "@/stores/grid/cellEditor";
import type { ContentLanguage } from "@/lib/grid/detectContentType";
import { cn } from "@/lib/utils";

interface Props {
  /** Absent for a query result: no column identity, so nothing to bind. */
  binding?: CellBindingContext;
  /** Current buffer, used for inference and for the own-`$schema` warning. */
  value: string;
  /** The chip hides itself unless the editor is in JSON mode. */
  language: ContentLanguage;
  /** `header` for the editor rails, `compact` for the structure editor row. */
  variant?: "header" | "compact";
  /** Extra classes on the trigger — e.g. `ml-auto` to pin it to a toolbar's
   *  far edge. Only takes effect while the badge actually renders. */
  className?: string;
}

export function SchemaBindingBadge({
  binding,
  value,
  language,
  variant = "header",
  className,
}: Props) {
  const { t } = useTranslation();
  const schemas = useJsonSchemas((s) => s.schemas);
  const resolvedAll = useJsonSchemas((s) => s.resolved);
  const revision = useJsonSchemas((s) => s.revision);
  const resolveColumn = useJsonSchemas((s) => s.resolveColumn);
  const saveBinding = useJsonSchemas((s) => s.saveBinding);
  const deleteBinding = useJsonSchemas((s) => s.deleteBinding);
  const openSettings = useSettingsDialog((s) => s.openAt);
  const [inferOpen, setInferOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const key = binding
    ? relationKey(binding.connectionId, binding.dbSchema, binding.table)
    : null;
  // Read the batch cache first (filled once per data tab). Derive, never select
  // a filtered value — gotcha #1.
  const resolved = useMemo(
    () => (key && binding ? resolvedAll[key]?.[binding.column] : undefined),
    [key, binding, resolvedAll],
  );

  // A MongoDB nested path is synthesised only when the user expands the field, so
  // the batch call for the relation could not have covered it. One extra call,
  // on an explicit user action.
  useEffect(() => {
    if (!binding || resolved || language !== "json") return;
    void resolveColumn(
      binding.connectionId,
      binding.dbSchema,
      binding.table,
      binding.column,
    );
  }, [binding, resolved, language, resolveColumn, revision]);

  const declared = useMemo(() => declaresOwnSchema(value), [value]);
  const valueIsJson = useMemo(() => {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }, [value]);

  // Hidden outside JSON mode (it sits beside `JsonValidationBadge`, which is
  // gated the same way) and hidden with no coordinates to bind to.
  if (language !== "json" || !binding) return null;

  const scope = formatScopeLabel(
    {
      connectionId: binding.connectionId ?? null,
      dbSchema: binding.dbSchema ?? null,
      table: binding.table ?? null,
      column: binding.column,
    },
    t,
  );

  async function link(schemaId: string) {
    if (!binding) return;
    setBusy(true);
    try {
      // Always the most specific scope: this connection, this schema, this
      // table, this column. Broadening is a deliberate edit in Settings.
      const previous = resolved;
      await saveBinding(
        draftBinding(
          schemaId,
          binding.connectionId,
          binding.dbSchema,
          binding.table,
          binding.column,
        ),
      );
      const name = schemas.find((s) => s.id === schemaId)?.name ?? schemaId;
      // Naming the rule that just lost is what stops "why are there suddenly two
      // rows in Settings?" from being a mystery.
      if (previous && !previous.exact) {
        notify.success(
          t("jsonSchemas.toast.boundShadowing", {
            name,
            scope,
            previous: previous.name,
          }),
        );
      } else {
        notify.success(t("jsonSchemas.toast.bound", { name, scope }));
      }
    } catch (e) {
      notify.error(t("jsonSchemas.toast.saveFailed", { message: String(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (!resolved) return;
    setBusy(true);
    try {
      await deleteBinding(resolved.bindingId);
      notify.success(t("jsonSchemas.toast.unbound", { scope }));
    } catch (e) {
      notify.error(t("jsonSchemas.toast.saveFailed", { message: String(e) }));
    } finally {
      setBusy(false);
    }
  }

  const isHeader = variant === "header";
  // `header` sits in the editor toolbar next to "Formatear" and must read as
  // a peer button, not a stray tag — hence riding the same `buttonVariants`
  // (outline, sm) rather than the compact chip the structure editor's inline
  // table row still uses (`compact`, unchanged below).
  const triggerBase = isHeader
    ? cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")
    : "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-3xs leading-none transition-colors";
  const bound = Boolean(resolved);
  const tooltip = declared
    ? t("jsonSchemas.badge.ownSchemaTooltip", { uri: declared })
    : resolved
      ? resolved.exact
        ? t("jsonSchemas.badge.boundTooltip", {
            name: resolved.name,
            scope,
          })
        : t("jsonSchemas.badge.inheritedTooltip", { scope })
      : t("jsonSchemas.badge.noneTooltip");

  // Still a hand-rolled `<button>` on purpose: one trigger serves two shapes —
  // `header` rides `buttonVariants` so it reads as a toolbar peer, `compact` is
  // the rounded data chip of the structure editor's row — and `Button` would
  // own only the first. The tooltip is the themed one, outermost, per
  // `SimpleTooltip`'s note on wrapping a menu trigger.
  return (
    <>
      <DropdownMenu>
        <SimpleTooltip label={tooltip}>
          <DropdownMenuTrigger asChild disabled={busy}>
            <button
              type="button"
              className={cn(
                triggerBase,
                bound &&
                  (isHeader
                    ? "border-brand/40 bg-brand/10 text-brand hover:border-brand/40 hover:bg-brand/20 hover:text-brand"
                    : "border-brand/40 bg-brand/10 text-brand hover:bg-brand/20"),
                !bound &&
                  !isHeader &&
                  "border-border/60 text-muted-foreground/70 hover:text-foreground",
                // A document declaring its own `$schema` wins over any binding, so
                // say so rather than showing a chip that is quietly not in effect.
                declared &&
                  (isHeader
                    ? "border-warning/50 bg-warning/10 text-warning hover:border-warning/50 hover:bg-warning/20 hover:text-warning"
                    : "border-warning/50 bg-warning/10 text-warning"),
                variant === "compact" && "px-1.5",
                className,
              )}
            >
              <FileJson
                className={cn("shrink-0", isHeader ? "h-3.5 w-3.5" : "h-3 w-3")}
              />
              {declared ? (
                <span>{t("jsonSchemas.badge.ownSchema")}</span>
              ) : resolved ? (
                <>
                  <span className="max-w-[14ch] truncate">{resolved.name}</span>
                  {!resolved.exact && (
                    <span className="opacity-70">
                      {t("jsonSchemas.badge.inherited")}
                    </span>
                  )}
                </>
              ) : (
                <span>{t("jsonSchemas.badge.none")}</span>
              )}
            </button>
          </DropdownMenuTrigger>
        </SimpleTooltip>

        <DropdownMenuContent align="start" className="w-64">
          <div className="px-2 py-1.5 font-mono text-2xs text-muted-foreground">
            {t("jsonSchemas.badge.menuTitle", { column: binding.column })}
          </div>
          <DropdownMenuSeparator />

          {schemas.length === 0 ? (
            <DropdownMenuItem disabled>
              {t("jsonSchemas.badge.emptyLibrary")}
            </DropdownMenuItem>
          ) : (
            schemas.map((s) => (
              <DropdownMenuCheckboxItem
                key={s.id}
                checked={resolved?.schemaId === s.id}
                onCheckedChange={() => void link(s.id)}
              >
                <span className="truncate">{s.name}</span>
              </DropdownMenuCheckboxItem>
            ))
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!valueIsJson}
            title={
              valueIsJson ? undefined : t("jsonSchemas.badge.inferNeedsJson")
            }
            onSelect={(e: Event) => {
              // Keep the dropdown from stealing focus back before the dialog
              // mounts.
              e.preventDefault();
              setInferOpen(true);
            }}
          >
            <Sparkles className="mr-2 h-3.5 w-3.5" />
            {t("jsonSchemas.badge.infer")}
          </DropdownMenuItem>

          {resolved && resolved.exact && (
            <DropdownMenuItem onSelect={() => void unlink()}>
              <X className="mr-2 h-3.5 w-3.5" />
              {t("jsonSchemas.badge.unlink")}
            </DropdownMenuItem>
          )}
          {resolved && !resolved.exact && (
            <DropdownMenuItem onSelect={() => openSettings("jsonSchemas")}>
              <Pencil className="mr-2 h-3.5 w-3.5" />
              {t("jsonSchemas.badge.editRule")}
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => openSettings("jsonSchemas")}>
            <Settings2 className="mr-2 h-3.5 w-3.5" />
            {t("jsonSchemas.badge.manage")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <InferSchemaDialog
        open={inferOpen}
        onOpenChange={setInferOpen}
        value={value}
        binding={binding}
        scopeLabel={scope}
      />
    </>
  );
}
