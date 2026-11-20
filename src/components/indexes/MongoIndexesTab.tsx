/**
 * MongoDB index manager — one collection's index catalogue, and the four
 * things you can do to it.
 *
 * MongoDB-only, and a tab of its own rather than a section of the structure
 * editor. That editor is built around SQL DDL diffing, and its `IndexDef`
 * carries a name, a list of column names and `unique` — everything the SQL
 * drivers need and nowhere near enough here, where an index also has a
 * direction per key, a type, a TTL, a partial filter, a collation and text
 * weights. Widening the shared DTO to fit MongoDB would have made it wrong for
 * both. The structure tab stays read-only for Mongo and links here instead.
 *
 * The list is deliberately more than names: **size** and **usage** are what
 * turn it from a catalogue into a tool. An index with a long `usageSince` and
 * zero operations is one nobody queries and everybody pays to maintain — the
 * single most useful thing a manager like this can tell you. Both columns come
 * from `$collStats` / `$indexStats`, which need their own privileges, so they
 * degrade to "—" rather than failing the listing.
 *
 * Hiding is offered next to dropping on purpose: it is the reversible
 * rehearsal. The planner stops using a hidden index while the server keeps
 * maintaining it, so its absence can be measured and undone instantly, which
 * dropping cannot.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notify";
import { PolicyLockHint } from "@/components/common/PolicyLock";
import { usePolicyLock } from "@/lib/policy/access";
import { Badge } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { IndexEditorDialog } from "@/components/indexes/dialogs/IndexEditorDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { confirmDestructive } from "@/lib/confirmDestructive";
import { api } from "@/lib/tauri";
import { cn, formatBytes, formatDateTime, formatNumber } from "@/lib/utils";
import type { MongoIndexInfo, NewMongoIndexSpec } from "@/types";
import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

interface Props {
  tabId: string;
  connectionId: string;
  schema?: string;
  collection?: string;
}

export function MongoIndexesTab({ connectionId, schema, collection }: Props) {
  const { t } = useTranslation();
  // Listing indexes is a read (the tab's gate); creating, hiding and dropping
  // one is DDL on the collection.
  const ddlLock = usePolicyLock(
    connectionId,
    "ddl",
    collection ? { schema, name: collection } : null,
  );
  const [indexes, setIndexes] = useState<MongoIndexInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MongoIndexInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!collection) return;
    setLoading(true);
    setError(null);
    api
      .listMongoIndexes(connectionId, collection)
      .then(setIndexes)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [connectionId, collection]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Whether the server answered the enrichment aggregations at all. When it
  // didn't, the columns are dropped rather than filled with a column of
  // dashes that reads like "this index is unused" — the opposite of the truth.
  const hasStats = useMemo(
    () => ({
      size: !!indexes?.some((i) => i.sizeBytes != null),
      usage: !!indexes?.some((i) => i.usageOps != null),
    }),
    [indexes],
  );

  /**
   * One index operation. `doneKey` is what to say when the server accepts it —
   * building or dropping an index is work the server does at its own pace, and
   * the list quietly re-rendering afterwards is a weak signal that it finished
   * rather than gave up. Failures stay inline: this tab has an error slot of
   * its own, right above the list the operation was aimed at.
   */
  async function run(name: string, doneKey: string, action: () => Promise<void>) {
    setBusy(name);
    setError(null);
    try {
      await action();
      refresh();
      notify.success(t(doneKey, { name }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onDrop(index: MongoIndexInfo) {
    if (
      !(await confirmDestructive(
        t("indexes.confirmDrop", { name: index.name, collection }),
      ))
    ) {
      return;
    }
    void run(index.name, "indexes.dropped", () =>
      api.dropMongoIndex(connectionId, collection!, index.name),
    );
  }

  function onToggleHidden(index: MongoIndexInfo) {
    void run(
      index.name,
      index.hidden ? "indexes.unhidden" : "indexes.hidden",
      () =>
        api.setMongoIndexHidden(
          connectionId,
          collection!,
          index.name,
          !index.hidden,
        ),
    );
  }

  async function onSubmit(spec: NewMongoIndexSpec) {
    // Replacing is a drop plus a create — MongoDB cannot alter an index in
    // place — so the collection runs without it while the new one builds.
    // Recoverable (the definition is right here), hence the preference-gated
    // confirmation rather than the irreversible one.
    if (
      editing &&
      !(await confirmDestructive(
        t("indexes.confirmReplace", { name: editing.name }),
      ))
    ) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      if (editing) {
        await api.recreateMongoIndex({
          connectionId,
          collection: collection!,
          originalName: editing.name,
          spec,
        });
      } else {
        await api.createMongoIndex({
          connectionId,
          collection: collection!,
          spec,
        });
      }
      setEditorOpen(false);
      refresh();
      // Building an index is the slowest thing this tab does, and the dialog
      // closing is indistinguishable from cancelling it.
      // `spec.name` is optional — a blank one is derived server-side from the
      // keys, so there is genuinely no name to quote back yet.
      const label = editing?.name ?? spec.name?.trim();
      notify.success(
        label
          ? t(editing ? "indexes.replaced" : "indexes.created", { name: label })
          : t("indexes.createdUnnamed"),
      );
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!collection) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        {t("indexes.noCollection")}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("indexes.title")}
          </div>
          <div className="truncate font-mono text-xs text-foreground">
            {collection}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            icon={RefreshCw}
            onClick={refresh}
            loading={loading}
            label={t("indexes.refresh")}
          />
          <PolicyLockHint reason={ddlLock}>
            <Button
              size="sm"
              disabled={!!ddlLock}
              onClick={() => {
                setEditing(null);
                setSaveError(null);
                setEditorOpen(true);
              }}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t("indexes.create")}
            </Button>
          </PolicyLockHint>
        </div>
      </div>

      {error && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b border-border/50 text-2xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-1.5 text-left font-medium">
                {t("indexes.columns.name")}
              </th>
              <th className="px-3 py-1.5 text-left font-medium">
                {t("indexes.columns.keys")}
              </th>
              <th className="px-3 py-1.5 text-left font-medium">
                {t("indexes.columns.properties")}
              </th>
              {hasStats.size && (
                <th className="px-3 py-1.5 text-right font-medium">
                  {t("indexes.columns.size")}
                </th>
              )}
              {hasStats.usage && (
                <th className="px-3 py-1.5 text-right font-medium">
                  {t("indexes.columns.usage")}
                </th>
              )}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {indexes === null && !error && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-4 text-xs italic text-muted-foreground"
                >
                  {t("indexes.loading")}
                </td>
              </tr>
            )}
            {indexes?.map((index) => (
              <tr
                key={index.name}
                className={cn(
                  "border-b border-border/30 hover:bg-accent",
                  busy === index.name && "opacity-50",
                  index.hidden && "text-muted-foreground",
                )}
              >
                <td className="px-3 py-1.5">
                  <div className="font-mono text-xs">{index.name}</div>
                  <div className="text-2xs text-muted-foreground">
                    {t(`indexes.kind.${index.kind}`)}
                  </div>
                </td>
                <td className="px-3 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {index.keys.map((key) => (
                      <KeyChip
                        key={key.field}
                        field={key.field}
                        value={key.value}
                      />
                    ))}
                  </div>
                </td>
                <td className="px-3 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {index.unique && <Badge>{t("indexes.flags.unique")}</Badge>}
                    {index.sparse && <Badge>{t("indexes.flags.sparse")}</Badge>}
                    {index.hidden && <Badge>{t("indexes.flags.hidden")}</Badge>}
                    {index.expireAfterSeconds != null && (
                      <Badge>
                        {t("indexes.badge.ttl", {
                          seconds: index.expireAfterSeconds,
                        })}
                      </Badge>
                    )}
                    {index.partialFilterExpression && (
                      <SimpleTooltip label={index.partialFilterExpression}>
                        <span>
                          <Badge>{t("indexes.badge.partial")}</Badge>
                        </span>
                      </SimpleTooltip>
                    )}
                    {index.collation && (
                      <SimpleTooltip label={index.collation}>
                        <span>
                          <Badge>{t("indexes.badge.collation")}</Badge>
                        </span>
                      </SimpleTooltip>
                    )}
                    {index.extraOptions && (
                      <SimpleTooltip label={index.extraOptions}>
                        <span>
                          <Badge>{t("indexes.badge.extra")}</Badge>
                        </span>
                      </SimpleTooltip>
                    )}
                  </div>
                </td>
                {hasStats.size && (
                  <td className="px-3 py-1.5 text-right font-mono text-xs text-muted-foreground">
                    {index.sizeBytes != null
                      ? formatBytes(index.sizeBytes)
                      : "—"}
                  </td>
                )}
                {hasStats.usage && (
                  <td className="px-3 py-1.5 text-right">
                    <UsageCell ops={index.usageOps} since={index.usageSince} />
                  </td>
                )}
                <td className="px-1 py-1.5">
                  <DropdownMenu>
                    <PolicyLockHint reason={index.isId ? null : ddlLock}>
                      <DropdownMenuTrigger asChild>
                        <IconButton
                          icon={MoreHorizontal}
                          label={
                            index.isId
                              ? t("indexes.idIndexLocked")
                              : (ddlLock ?? t("indexes.actions"))
                          }
                          disabled={
                            index.isId || busy === index.name || !!ddlLock
                          }
                        />
                      </DropdownMenuTrigger>
                    </PolicyLockHint>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() => {
                          setEditing(index);
                          setSaveError(null);
                          setEditorOpen(true);
                        }}
                      >
                        <Pencil className="mr-2 h-3.5 w-3.5" />
                        {t("indexes.edit")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onToggleHidden(index)}>
                        {index.hidden ? (
                          <Eye className="mr-2 h-3.5 w-3.5" />
                        ) : (
                          <EyeOff className="mr-2 h-3.5 w-3.5" />
                        )}
                        {index.hidden ? t("indexes.unhide") : t("indexes.hide")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={() => onDrop(index)}
                      >
                        <Trash2 className="mr-2 h-3.5 w-3.5" />
                        {t("indexes.drop")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <IndexEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        editing={editing}
        collection={collection}
        saving={saving}
        error={saveError}
        onSubmit={onSubmit}
      />
    </div>
  );
}

/** One key of an index: the field path, plus its direction or type. */
function KeyChip({ field, value }: { field: string; value: string }) {
  const direction = value === "1" ? "asc" : value === "-1" ? "desc" : null;
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-2xs">
      {field}
      {direction === "asc" ? (
        <ArrowUp className="h-3 w-3 text-muted-foreground" />
      ) : direction === "desc" ? (
        <ArrowDown className="h-3 w-3 text-muted-foreground" />
      ) : (
        <span className="text-muted-foreground">{value}</span>
      )}
    </span>
  );
}

/**
 * Operations served, with the counter's start date underneath. The two only
 * mean something together: `$indexStats` resets on a server restart, so a low
 * count against a recent `since` says nothing at all.
 */
function UsageCell({
  ops,
  since,
}: {
  ops?: number | null;
  since?: string | null;
}) {
  const { t } = useTranslation();
  if (ops == null) {
    return <span className="font-mono text-xs text-muted-foreground">—</span>;
  }
  return (
    <SimpleTooltip
      label={
        since
          ? t("indexes.usageSince", { date: formatDateTime(since) })
          : t("indexes.usageUnknownSince")
      }
    >
      <span
        className={cn(
          "font-mono text-xs",
          ops === 0 ? "text-warning" : "text-muted-foreground",
        )}
      >
        {formatNumber(ops)}
      </span>
    </SimpleTooltip>
  );
}
