/**
 * Two panels and a pair of arrows: what is *here* on the left, what is *in the
 * document* on the right.
 *
 * There was no such primitive. The three export dialogs are checklists over one
 * list, which is a different shape: a checklist answers "which of these", a
 * transfer list answers "which of these belong over there" — and the origin
 * editor's whole point is that the two sides are different collections (this
 * machine's `profiles.json` on one side, the published document on the other).
 *
 * Deliberately not drag-and-drop. `@dnd-kit` is already in the tree (its one
 * call site is `EnvironmentRail`), so it could be, but the arrows work with a
 * keyboard and a multi-selection at once and are what a filtered list needs:
 * dragging out of a search result the filter is about to hide is not a gesture
 * anybody completes twice. Double-click is the shortcut for the common
 * single-item case.
 *
 * Rows are supplied by the caller (`renderItem`), so the connections pane can
 * show a driver badge and a lock while a future pane shows something else. The
 * only thing this owns is which side an id is on, the per-side filter, and the
 * selection inside each side.
 */

import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { SimpleTooltip } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface TransferItem {
  id: string;
  /** Everything the filter box matches against, already lowercased by the
   *  caller if it wants case-insensitivity beyond the name. */
  haystack: string;
}

/** One side's own selection, so a click on the left cannot silently arm the
 *  right-hand arrow. */
function useSideSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return {
    selected,
    clear: () => setSelected(new Set()),
    toggle: (id: string) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
  };
}

function Panel({
  title,
  count,
  items,
  selected,
  onToggle,
  onCommit,
  renderItem,
  empty,
}: {
  title: string;
  count: number;
  items: TransferItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  /** Double-click: move this one id across without touching the selection. */
  onCommit: (id: string) => void;
  renderItem: (id: string) => ReactNode;
  empty: string;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const visible = useMemo(
    () => (needle ? items.filter((i) => i.haystack.includes(needle)) : items),
    [items, needle],
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card/40 px-2.5 py-1.5">
        <span className="truncate text-xs font-semibold">{title}</span>
        <span className="shrink-0 text-2xs text-muted-foreground">{count}</span>
      </div>
      <div className="border-b border-border p-1.5">
        <Input
          className="h-7 text-xs"
          placeholder={t("originEditor.filterPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <p className="p-3 text-center text-2xs text-muted-foreground">
            {needle ? t("originEditor.noMatches") : empty}
          </p>
        ) : (
          visible.map((item) => (
            <label
              key={item.id}
              className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 hover:bg-accent"
              onDoubleClick={() => onCommit(item.id)}
            >
              <Checkbox
                checked={selected.has(item.id)}
                onChange={() => onToggle(item.id)}
              />
              <div className="min-w-0 flex-1">{renderItem(item.id)}</div>
            </label>
          ))
        )}
      </div>
    </div>
  );
}

export function TransferList({
  leftTitle,
  rightTitle,
  left,
  right,
  onAdd,
  onRemove,
  renderLeft,
  renderRight,
  leftEmpty,
  rightEmpty,
}: {
  leftTitle: string;
  rightTitle: string;
  /** Available but not in the document. */
  left: TransferItem[];
  /** In the document. */
  right: TransferItem[];
  onAdd: (ids: string[]) => void;
  onRemove: (ids: string[]) => void;
  renderLeft: (id: string) => ReactNode;
  renderRight: (id: string) => ReactNode;
  leftEmpty: string;
  rightEmpty: string;
}) {
  const leftSel = useSideSelection();
  const rightSel = useSideSelection();

  // Filter the selections against what is still on that side: an id moved
  // across (or removed from `profiles.json` in another window) must not stay
  // armed for an arrow that can no longer act on it.
  const armedLeft = useMemo(
    () => left.filter((i) => leftSel.selected.has(i.id)).map((i) => i.id),
    [left, leftSel.selected],
  );
  const armedRight = useMemo(
    () => right.filter((i) => rightSel.selected.has(i.id)).map((i) => i.id),
    [right, rightSel.selected],
  );

  return (
    <div className="flex min-h-0 flex-1 items-stretch gap-2">
      <Panel
        title={leftTitle}
        count={left.length}
        items={left}
        selected={leftSel.selected}
        onToggle={leftSel.toggle}
        onCommit={(id) => onAdd([id])}
        renderItem={renderLeft}
        empty={leftEmpty}
      />
      <div className="flex flex-col justify-center gap-1.5">
        {/* These two keep their outline rather than becoming `IconButton`s:
            the border is what makes them read as this component's central
            action rather than incidental chrome. Only the tooltip changes,
            from the OS's to the themed one. */}
        <SimpleTooltip label={rightTitle}>
          <Button
            size="icon"
            variant="outline"
            className="h-7 w-7"
            disabled={armedLeft.length === 0}
            onClick={() => {
              onAdd(armedLeft);
              leftSel.clear();
            }}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label={leftTitle}>
          <Button
            size="icon"
            variant="outline"
            className="h-7 w-7"
            disabled={armedRight.length === 0}
            onClick={() => {
              onRemove(armedRight);
              rightSel.clear();
            }}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
        </SimpleTooltip>
      </div>
      <Panel
        title={rightTitle}
        count={right.length}
        items={right}
        selected={rightSel.selected}
        onToggle={rightSel.toggle}
        onCommit={(id) => onRemove([id])}
        renderItem={renderRight}
        empty={rightEmpty}
      />
    </div>
  );
}
