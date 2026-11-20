/**
 * One stage of the pipeline: its source on the left, the documents it emits on
 * the right.
 *
 * The right half is the whole point of the stage editor — it shows the output
 * of the pipeline *truncated after this stage*, so a sixteen-stage `$lookup`
 * chain can be read one step at a time instead of as a single opaque result.
 * That preview is computed by the backend (`preview_mongo_stages`) and handed
 * in; this component only renders it.
 *
 * Three states worth knowing:
 *
 * - **disabled** — the stage stays in the document and out of every request.
 *   Drawn muted with a dashed edge, and with no preview, because nothing ran.
 * - **collapsed** — header only. Useful once a stage is settled; the preview is
 *   still computed (later stages depend on it), just not shown.
 * - **empty output** — the stage ran and produced zero documents. Flagged in
 *   `warning`, because "where did my data go" is the question the stage editor
 *   exists to answer and a silent empty list doesn't answer it.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  BetweenHorizontalStart,
  ChevronDown,
  ChevronRight,
  Copy,
  GripVertical,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { IconButton } from "@/components/ui/icon-button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PipelineEditor } from "@/components/aggregation/PipelineEditor";
import { PipelineOutput } from "@/components/aggregation/PipelineOutput";
import { STAGE_CATALOG } from "@/lib/mongo/stages";
import {
  operatorOf,
  withOperator,
  type PipelineStage,
} from "@/lib/mongo/pipeline";
import { cn } from "@/lib/utils";
import type { StagePreview } from "@/types";
import type { MongoCompletionEntry } from "@/lib/monaco/monacoMongo";

interface Props {
  stage: PipelineStage;
  index: number;
  preview?: StagePreview;
  previewing: boolean;
  /** Whether the output column is shown at all (the tab's preview toggle). */
  showPreview: boolean;
  collapsed: boolean;
  /** Drag feedback owned by the parent: this card is the one being dragged,
   *  or the one it would land above. */
  dragging: boolean;
  dropTarget: boolean;
  onChange: (body: string) => void;
  onToggleEnabled: () => void;
  onToggleCollapsed: () => void;
  /**
   * Insert a fresh stage immediately *above* this one.
   *
   * Above rather than below, and it is the difference between covering every
   * position and covering all but one: with the "add stage" button at the foot
   * of the list appending, one "insert above" per card reaches every gap in the
   * pipeline including the very top — and the top is the position that matters
   * most, since filtering early with a `$match` is the single most common thing
   * a pipeline wants added in front of what is already there. "Insert below"
   * would need a second button, or a special case on the first card, to reach
   * it at all.
   */
  onInsertBefore: () => void;
  /** Copy this stage, placing the copy directly after it. */
  onDuplicate: () => void;
  onDelete: () => void;
  onRun: () => void;
  /** Format this stage's body (the right-click menu's Format). */
  onFormat: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDragEnd: () => void;
  /** Live collection/field data for this stage's completion suggestions. */
  completion?: MongoCompletionEntry;
}

/** Editor height from the body's own length: a three-line `$limit` shouldn't
 *  reserve the same space as a thirty-line `$lookup`, and neither should be
 *  allowed to push the next card off screen. */
function editorHeight(body: string): number {
  const lines = body.split("\n").length;
  return Math.min(420, Math.max(120, lines * 19 + 24));
}

export function StageCard({
  stage,
  index,
  preview,
  previewing,
  showPreview,
  collapsed,
  dragging,
  dropTarget,
  onChange,
  onToggleEnabled,
  onToggleCollapsed,
  onInsertBefore,
  onDuplicate,
  onDelete,
  onRun,
  onFormat,
  onDragStart,
  onDragOver,
  onDragEnd,
  completion,
}: Props) {
  const { t } = useTranslation();
  const operator = operatorOf(stage.body);
  const known = useMemo(
    () => STAGE_CATALOG.some((s) => s.operator === operator),
    [operator],
  );

  const rows = preview?.result?.rows.length ?? 0;
  const emptyOutput = !!preview?.result && rows === 0;
  const height = editorHeight(stage.body);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      className={cn(
        "rounded-lg border bg-card transition-opacity",
        stage.enabled
          ? "border-border"
          : "border-dashed border-border opacity-60",
        dragging && "opacity-40",
        // Drop indicator: a brand rule on the edge the card would land above,
        // rather than moving anything mid-drag.
        dropTarget && "shadow-[0_-2px_0_0_var(--brand)]",
        preview?.error && "border-destructive/50",
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <span
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
          title={t("aggregation.stage.reorder")}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </span>

        <IconButton
          size="xs"
          icon={collapsed ? ChevronRight : ChevronDown}
          label={
            collapsed
              ? t("aggregation.stage.expand")
              : t("aggregation.stage.collapse")
          }
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        />

        <span className="text-2xs uppercase tracking-wider text-muted-foreground">
          {t("aggregation.stage.label", { index: index + 1 })}
        </span>

        <Select
          value={known && operator ? operator : ""}
          onValueChange={(next) => onChange(withOperator(stage.body, next))}
        >
          <SelectTrigger className="h-6 w-44 font-mono text-2xs">
            {/* An operator the catalogue doesn't know (a newer server stage,
                typed by hand) still has to read correctly in the header, so the
                trigger falls back to the parsed name rather than showing the
                placeholder over a perfectly valid stage. */}
            <SelectValue
              placeholder={operator ?? t("aggregation.stage.pick")}
            />
          </SelectTrigger>
          <SelectContent>
            {STAGE_CATALOG.map((s) => (
              <SelectItem
                key={s.operator}
                value={s.operator}
                className="font-mono text-2xs"
              >
                {s.operator}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Output size for this stage — the diagnostic the whole surface is
            built around. `10+` when the sample hit its limit. */}
        {stage.enabled && preview?.result && (
          <span
            className={cn(
              "rounded-sm px-1.5 py-0.5 font-mono text-3xs",
              emptyOutput
                ? "bg-warning/15 text-warning"
                : "bg-muted text-muted-foreground",
            )}
            title={t("aggregation.stage.outputHint")}
          >
            {emptyOutput && <TriangleAlert className="mr-1 inline h-3 w-3" />}
            {t("aggregation.stage.docCount", {
              count: rows,
              suffix: preview.truncated ? "+" : "",
            })}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Stock `Switch` at its normal size — the same control the Settings
              dialog uses. A shrunken variant also breaks its own geometry: the
              thumb keeps its `h-4`/`translate-x-4`, so a `h-4 w-7` track leaves
              the thumb as tall as the track and sliding past its edge. */}
          <Switch
            checked={stage.enabled}
            onCheckedChange={onToggleEnabled}
            aria-label={t("aggregation.stage.toggle")}
            title={t("aggregation.stage.toggle")}
          />
          <IconButton
            size="xs"
            icon={BetweenHorizontalStart}
            label={t("aggregation.stage.insertBefore")}
            onClick={onInsertBefore}
          />
          <IconButton
            size="xs"
            icon={Copy}
            label={t("aggregation.stage.duplicate")}
            onClick={onDuplicate}
          />
          <IconButton
            size="xs"
            icon={Trash2}
            // `tone`, not a hand-rolled hover colour: same treatment as every
            // other destructive control, decided once in `IconButton`.
            tone="destructive"
            label={t("aggregation.stage.delete")}
            onClick={onDelete}
          />
        </div>
      </div>

      {!collapsed && (
        <div style={{ height }}>
          <PanelGroup direction="horizontal" className="h-full">
            <Panel defaultSize={showPreview ? 50 : 100} minSize={25}>
              <PipelineEditor
                value={stage.body}
                onChange={onChange}
                onRun={onRun}
                height="100%"
                completion={completion}
                menuHeader={{ title: operator ?? t("editorMenu.subject.stage") }}
                onFormat={onFormat}
              />
            </Panel>
            {showPreview && (
              <>
                <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-brand/40" />
                <Panel defaultSize={50} minSize={20}>
                  {stage.enabled ? (
                    <PipelineOutput
                      result={preview?.result ?? null}
                      error={preview?.error ?? null}
                      loading={previewing}
                      truncated={preview?.truncated}
                      emptyLabel={t("aggregation.stage.previewPending")}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center px-4 text-center text-2xs text-muted-foreground">
                      {t("aggregation.stage.disabledHint")}
                    </div>
                  )}
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>
      )}
    </div>
  );
}
