/**
 * Create or replace one MongoDB index.
 *
 * Two halves. The **keys** are the part everyone edits, so they get a
 * structured form: one row per key, a field path and a value picker covering
 * the values MongoDB actually accepts (`1`, `-1`, `"text"`, `"2dsphere"`,
 * `"2d"`, `"hashed"`). An index whose keys the picker can't express — a future
 * key type, a geo tuning tuple — opens in **raw** mode instead, holding
 * `keysSource` verbatim; the toggle is always available, so raw is also the
 * escape hatch for anything the form makes awkward. Being unable to render an
 * index as a form must never mean being unable to edit it.
 *
 * The **options** below are plain fields plus three source-text documents
 * (partial filter, collation, text weights) in monospace textareas. Those are
 * relaxed Mongo syntax, not JSON — `{ status: { $eq: "active" } }` is valid
 * and a JSON validator would reject it — and they are parsed in Rust, whose
 * error message (with a position) is what surfaces on a bad one. That is the
 * ADR #33 contract: one grammar, on the Rust side, never a second one here.
 *
 * "Replace" is destructive by nature: MongoDB cannot alter an index in place,
 * so saving an edit drops the old index and builds a new one, and the
 * collection runs without it in between. The dialog says so and the caller
 * confirms before the call.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  KEY_VALUES,
  keyRowsToSource,
  keysToRows,
  type KeyRow,
} from "@/lib/mongo/indexKeys";
import { cn } from "@/lib/utils";
import type { MongoIndexInfo, NewMongoIndexSpec } from "@/types";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The index being replaced; absent when creating. */
  editing?: MongoIndexInfo | null;
  collection: string;
  saving: boolean;
  error: string | null;
  onSubmit: (spec: NewMongoIndexSpec) => void;
}

const BLANK_ROW: KeyRow = { field: "", value: "1" };

export function IndexEditorDialog({
  open,
  onOpenChange,
  editing,
  collection,
  saving,
  error,
  onSubmit,
}: Props) {
  const { t } = useTranslation();

  const [rows, setRows] = useState<KeyRow[]>([BLANK_ROW]);
  const [rawKeys, setRawKeys] = useState("");
  const [raw, setRaw] = useState(false);
  const [name, setName] = useState("");
  const [unique, setUnique] = useState(false);
  const [sparse, setSparse] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [ttl, setTtl] = useState("");
  const [partial, setPartial] = useState("");
  const [collation, setCollation] = useState("");
  const [weights, setWeights] = useState("");
  const [defaultLanguage, setDefaultLanguage] = useState("");
  const [extra, setExtra] = useState("");
  const [advanced, setAdvanced] = useState(false);

  // Reload the form from the index each time the dialog opens, so cancelling
  // an edit and reopening it doesn't resume the abandoned draft.
  useEffect(() => {
    if (!open) return;
    const structured = editing ? keysToRows(editing.keys) : null;
    setRows(structured ?? [BLANK_ROW]);
    setRawKeys(editing?.keysSource ?? "{ }");
    // An index the picker can't express opens raw rather than being quietly
    // flattened into something the picker *can* show.
    setRaw(!!editing && structured === null);
    setName(editing?.name ?? "");
    setUnique(editing?.unique ?? false);
    setSparse(editing?.sparse ?? false);
    setHidden(editing?.hidden ?? false);
    setTtl(
      editing?.expireAfterSeconds != null
        ? String(editing.expireAfterSeconds)
        : "",
    );
    setPartial(editing?.partialFilterExpression ?? "");
    setCollation(editing?.collation ?? "");
    setWeights(editing?.weights ?? "");
    setDefaultLanguage(editing?.defaultLanguage ?? "");
    setExtra(editing?.extraOptions ?? "");
    // Open the advanced block already expanded when the index uses any of it,
    // so an edit never hides part of what it is about to rewrite.
    setAdvanced(
      !!editing &&
        !!(
          editing.expireAfterSeconds != null ||
          editing.partialFilterExpression ||
          editing.collation ||
          editing.weights ||
          editing.defaultLanguage ||
          editing.extraOptions
        ),
    );
  }, [open, editing]);

  const keysSource = raw ? rawKeys : keyRowsToSource(rows);
  const hasKeys = raw
    ? rawKeys.trim() !== "" && rawKeys.trim() !== "{}"
    : rows.some((r) => r.field.trim() !== "");

  const ttlSeconds = ttl.trim() === "" ? null : Number(ttl.trim());
  const ttlInvalid =
    ttlSeconds !== null && (!Number.isFinite(ttlSeconds) || ttlSeconds < 0);

  function updateRow(index: number, patch: Partial<KeyRow>) {
    setRows((prev) =>
      prev.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    );
  }

  function submit() {
    onSubmit({
      keys: keysSource,
      name: name.trim() || null,
      unique,
      sparse,
      hidden,
      expireAfterSeconds: ttlSeconds,
      partialFilterExpression: partial.trim() || null,
      collation: collation.trim() || null,
      weights: weights.trim() || null,
      defaultLanguage: defaultLanguage.trim() || null,
      extraOptions: extra.trim() || null,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent tier="panel" className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t("indexes.editor.titleEdit", { name: editing.name })
              : t("indexes.editor.titleCreate")}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? t("indexes.editor.descriptionEdit", { collection })
              : t("indexes.editor.descriptionCreate", { collection })}
          </DialogDescription>
        </DialogHeader>

        {/* The scroll boundary used to sit on this div alone (`flex-1
            overflow-y-auto`), independent of the `panel` tier's own body
            scroller. It now sits on `DialogBody` instead, which already
            supplies `min-h-0 overflow-y-auto` for this tier. */}
        <DialogBody className="space-y-4">
          {/* Keys ------------------------------------------------------- */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t("indexes.editor.keys")}</Label>
              <Button
                type="button"
                variant="link"
                size="xs"
                className="px-0"
                onClick={() => {
                  // Switching into raw seeds it from the rows so the text
                  // starts as what the form was already describing.
                  if (!raw) setRawKeys(keyRowsToSource(rows));
                  setRaw(!raw);
                }}
              >
                {raw
                  ? t("indexes.editor.keysForm")
                  : t("indexes.editor.keysRaw")}
              </Button>
            </div>

            {raw ? (
              <Textarea
                value={rawKeys}
                onChange={(e) => setRawKeys(e.target.value)}
                rows={3}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder="{ createdAt: -1, status: 1 }"
              />
            ) : (
              <div className="space-y-1.5">
                {rows.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={row.field}
                      onChange={(e) => updateRow(i, { field: e.target.value })}
                      placeholder={t("indexes.editor.fieldPlaceholder")}
                      className="flex-1 font-mono text-xs"
                      spellCheck={false}
                    />
                    <Select
                      value={row.value}
                      onValueChange={(value) => updateRow(i, { value })}
                    >
                      <SelectTrigger className="w-36 font-mono text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {KEY_VALUES.map((value) => (
                          <SelectItem
                            key={value}
                            value={value}
                            className="font-mono text-xs"
                          >
                            {t(`indexes.keyValue.${value.replace(/"/g, "")}`, {
                              defaultValue: value,
                            })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <IconButton
                      icon={Trash2}
                      label={t("indexes.editor.removeKey")}
                      disabled={rows.length === 1}
                      onClick={() =>
                        setRows((prev) => prev.filter((_, j) => j !== i))
                      }
                    />
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRows((prev) => [...prev, { ...BLANK_ROW }])}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  {t("indexes.editor.addKey")}
                </Button>
              </div>
            )}
          </div>

          {/* Name + flags ---------------------------------------------- */}
          <div className="grid gap-1">
            <Label>{t("indexes.editor.name")}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("indexes.editor.namePlaceholder")}
              className="font-mono text-xs"
              spellCheck={false}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <FlagRow
              label={t("indexes.flags.unique")}
              hint={t("indexes.flags.uniqueHint")}
              checked={unique}
              onChange={setUnique}
            />
            <FlagRow
              label={t("indexes.flags.sparse")}
              hint={t("indexes.flags.sparseHint")}
              checked={sparse}
              onChange={setSparse}
            />
            <FlagRow
              label={t("indexes.flags.hidden")}
              hint={t("indexes.flags.hiddenHint")}
              checked={hidden}
              onChange={setHidden}
            />
          </div>

          {/* Advanced --------------------------------------------------- */}
          <Button
            type="button"
            variant="quiet"
            size="xs"
            icon={advanced ? ChevronDown : ChevronRight}
            aria-expanded={advanced}
            onClick={() => setAdvanced((v) => !v)}
          >
            {t("indexes.editor.advanced")}
          </Button>

          {advanced && (
            <div className="space-y-3 border-l border-border pl-3">
              <div className="grid gap-1">
                <Label>{t("indexes.editor.ttl")}</Label>
                <Input
                  value={ttl}
                  onChange={(e) => setTtl(e.target.value)}
                  inputMode="numeric"
                  placeholder={t("indexes.editor.ttlPlaceholder")}
                  className={cn("text-xs", ttlInvalid && "border-destructive")}
                />
                <p className="text-2xs text-muted-foreground">
                  {t("indexes.editor.ttlHint")}
                </p>
              </div>

              <DocumentField
                label={t("indexes.editor.partial")}
                hint={t("indexes.editor.partialHint")}
                value={partial}
                onChange={setPartial}
                placeholder='{ status: { $eq: "active" } }'
              />
              <DocumentField
                label={t("indexes.editor.collation")}
                hint={t("indexes.editor.collationHint")}
                value={collation}
                onChange={setCollation}
                placeholder='{ locale: "es", strength: 2 }'
              />
              <DocumentField
                label={t("indexes.editor.weights")}
                hint={t("indexes.editor.weightsHint")}
                value={weights}
                onChange={setWeights}
                placeholder="{ title: 10, body: 1 }"
              />

              <div className="grid gap-1">
                <Label>{t("indexes.editor.defaultLanguage")}</Label>
                <Input
                  value={defaultLanguage}
                  onChange={(e) => setDefaultLanguage(e.target.value)}
                  placeholder="english"
                  className="font-mono text-xs"
                  spellCheck={false}
                />
              </div>

              <DocumentField
                label={t("indexes.editor.extra")}
                hint={t("indexes.editor.extraHint")}
                value={extra}
                onChange={setExtra}
                placeholder="{ wildcardProjection: { secrets: 0 } }"
              />
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
              {error}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={!hasKeys || ttlInvalid || saving}>
            {saving
              ? t("indexes.editor.saving")
              : editing
                ? t("indexes.editor.replace")
                : t("indexes.editor.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FlagRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Switch checked={checked} onCheckedChange={onChange} />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p className="text-2xs leading-tight text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * One optional source-text document. Monospace and relaxed-syntax: these are
 * Mongo documents, not JSON, and the Rust parser is what judges them.
 */
function DocumentField({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="grid gap-1">
      <Label>{label}</Label>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        spellCheck={false}
        placeholder={placeholder}
        className="font-mono text-xs"
      />
      <p className="text-2xs text-muted-foreground">{hint}</p>
    </div>
  );
}
