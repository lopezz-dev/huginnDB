/**
 * Data-grid preferences — row height, page size, NULL rendering, plus the
 * schema-tree metric (previously surfaced only via the View menu).
 */

import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  usePreferences,
  selectGridPrefs,
  selectUiPrefs,
} from "@/stores/preferences/preferences";
import type { GridPrefs, SchemaTableMetric, TabAccentStyle } from "@/types";
import { PrefGroup } from "./PrefGroup";
import { PrefRow } from "./PrefRow";

const METRIC_KEYS: Record<SchemaTableMetric, string> = {
  none: "menu.view.metricHide",
  "row-count": "menu.view.metricRowCount",
  size: "menu.view.metricSize",
  both: "menu.view.metricBoth",
};

const TAB_ACCENT_KEYS: Record<TabAccentStyle, string> = {
  cap: "settings.grid.tabAccentStyle.cap",
  rail: "settings.grid.tabAccentStyle.rail",
  boxed: "settings.grid.tabAccentStyle.boxed",
};

export function GridSection() {
  const grid = usePreferences(selectGridPrefs);
  const ui = usePreferences(selectUiPrefs);
  const updateGrid = usePreferences((s) => s.updateGrid);
  const updateUi = usePreferences((s) => s.updateUi);
  const { t } = useTranslation();

  return (
    <div className="space-y-5">
      <PrefGroup title={t("settings.rowGroups.pagingLayout")}>
        <PrefRow
          label={t("settings.grid.defaultPageSize")}
          prefId="grid.defaultPageSize"
          htmlFor="prefs-grid-page-size"
        >
          <Input
            id="prefs-grid-page-size"
            type="number"
            min={10}
            max={5000}
            value={grid.defaultPageSize}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(n) && n > 0) {
                updateGrid({ defaultPageSize: n });
              }
            }}
            className="h-8 w-24 text-right font-mono text-xs"
          />
        </PrefRow>

        <PrefRow
          label={t("settings.grid.rowHeight")}
          prefId="grid.rowHeight"
          htmlFor="prefs-grid-row-height"
        >
          <Input
            id="prefs-grid-row-height"
            type="number"
            min={18}
            max={64}
            value={grid.rowHeight}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(n) && n > 0) updateGrid({ rowHeight: n });
            }}
            className="h-8 w-20 text-right font-mono text-xs"
          />
        </PrefRow>
      </PrefGroup>

      <PrefGroup title={t("settings.rowGroups.values")}>
        <PrefRow
          label={t("settings.grid.nullDisplay.label")}
          prefId="grid.nullDisplay"
          description={t("settings.grid.nullDisplay.desc")}
          htmlFor="prefs-grid-null-display"
        >
          <Input
            id="prefs-grid-null-display"
            value={grid.nullDisplay}
            onChange={(e) => updateGrid({ nullDisplay: e.target.value })}
            className="h-8 w-32 font-mono text-xs"
          />
        </PrefRow>

        <PrefRow
          label={t("settings.grid.truncateLongTextAt.label")}
          prefId="grid.truncateLongTextAt"
          description={t("settings.grid.truncateLongTextAt.desc")}
          htmlFor="prefs-grid-truncate"
        >
          <Input
            id="prefs-grid-truncate"
            type="number"
            min={0}
            max={100000}
            value={grid.truncateLongTextAt}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(n) && n >= 0) {
                updateGrid({ truncateLongTextAt: n });
              }
            }}
            className="h-8 w-24 text-right font-mono text-xs"
          />
        </PrefRow>

        <PrefRow
          label={t("settings.grid.trimLargeValuesKb.label")}
          prefId="grid.trimLargeValuesKb"
          description={t("settings.grid.trimLargeValuesKb.desc")}
          htmlFor="prefs-grid-trim-large"
        >
          <Input
            id="prefs-grid-trim-large"
            type="number"
            min={0}
            max={16384}
            value={grid.trimLargeValuesKb}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(n) && n >= 0) {
                updateGrid({ trimLargeValuesKb: n });
              }
            }}
            className="h-8 w-24 text-right font-mono text-xs"
          />
        </PrefRow>
      </PrefGroup>

      <PrefGroup title={t("settings.rowGroups.display")}>
        <PrefRow
          label={t("settings.grid.zebraStripes.label")}
          prefId="grid.zebraStripes"
          description={t("settings.grid.zebraStripes.desc")}
        >
          <Switch
            checked={grid.zebraStripes}
            onCheckedChange={(v) => updateGrid({ zebraStripes: v })}
          />
        </PrefRow>

        <PrefRow
          label={t("settings.grid.stickyHeader.label")}
          prefId="grid.stickyHeader"
          description={t("settings.grid.stickyHeader.desc")}
        >
          <Switch
            checked={grid.stickyHeader}
            onCheckedChange={(v) => updateGrid({ stickyHeader: v })}
          />
        </PrefRow>

        <PrefRow
          label={t("settings.grid.cellPreview.label")}
          prefId="grid.cellPreview"
          description={t("settings.grid.cellPreview.desc")}
        >
          <Switch
            checked={grid.cellPreview}
            onCheckedChange={(v) => updateGrid({ cellPreview: v })}
          />
        </PrefRow>

        <PrefRow
          label={t("settings.grid.bitDisplay.label")}
          prefId="grid.bitDisplay"
          description={t("settings.grid.bitDisplay.desc")}
        >
          <Select
            value={grid.bitDisplay}
            onValueChange={(v) =>
              updateGrid({ bitDisplay: v as GridPrefs["bitDisplay"] })
            }
          >
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true_false" className="text-xs">
                {t("settings.grid.bitDisplay.trueFalse")}
              </SelectItem>
              <SelectItem value="zero_one" className="text-xs">
                {t("settings.grid.bitDisplay.zeroOne")}
              </SelectItem>
            </SelectContent>
          </Select>
        </PrefRow>
      </PrefGroup>

      <PrefGroup title={t("settings.rowGroups.sidebarTabs")}>
        <PrefRow
          label={t("settings.grid.schemaMetric.label")}
          prefId="ui.schemaTableMetric"
          description={t("settings.grid.schemaMetric.desc")}
        >
          <Select
            value={ui.schemaTableMetric}
            onValueChange={(v) =>
              updateUi({ schemaTableMetric: v as SchemaTableMetric })
            }
          >
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(METRIC_KEYS) as SchemaTableMetric[]).map((k) => (
                <SelectItem key={k} value={k} className="text-xs">
                  {t(METRIC_KEYS[k])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PrefRow>

        <PrefRow
          label={t("settings.grid.tabAccentStyle.label")}
          prefId="ui.tabAccentStyle"
          description={t("settings.grid.tabAccentStyle.desc")}
        >
          <Select
            value={ui.tabAccentStyle}
            onValueChange={(v) =>
              updateUi({ tabAccentStyle: v as TabAccentStyle })
            }
          >
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(TAB_ACCENT_KEYS) as TabAccentStyle[]).map((k) => (
                <SelectItem key={k} value={k} className="text-xs">
                  {t(TAB_ACCENT_KEYS[k])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PrefRow>
      </PrefGroup>
    </div>
  );
}
