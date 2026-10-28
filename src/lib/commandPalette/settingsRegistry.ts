/**
 * Searchable index of the *individual* preferences, so the command palette can
 * take the user to one setting rather than only to the Preferences dialog —
 * VS Code's "Preferences: Open Settings" behaviour, where typing `word wrap`
 * lands on that exact row.
 *
 * Every entry names an existing i18n key from the Settings sections (nothing is
 * re-worded here — a second copy of "Soft-wrap long lines" would drift the
 * moment either side is edited) plus:
 *
 *   - `section`: which Settings section renders it, for `openAtPref`.
 *   - `prefId`: the anchor. Must equal the `prefId` passed to that setting's
 *     `PrefRow`, which is what `SettingsDialog` scrolls to and flashes. A typo
 *     here is a silent no-op highlight, so keep the two in sync — the ids are
 *     spelled as the preference path (`editor.wordWrap`, `ui.restoreTabsOnOpen`)
 *     to make the pairing obvious.
 *   - `value`: how the current value renders as a badge in the palette row.
 *   - `toggle`: booleans only. Present iff the row can be flipped in place, and
 *     what makes Alt+Enter work without opening the dialog at all.
 *
 * `keywords` carries search text in *both* UI languages on purpose: the palette
 * matches the translated label already, and someone running the Spanish UI
 * still types "wrap" as often as "ajuste de línea".
 */

import type { SettingsSection } from "@/components/settings/useSettingsDialog";
import { POSITION_LABEL_KEYS } from "@/lib/notificationPosition";
import type { PrefId } from "@/lib/prefId";
import { isWindows } from "@/lib/platform";
import type { Preferences, SchemaTableMetric } from "@/types";

/** Label key per schema-tree metric. Total by construction, so adding a value
 *  to the union is a compile error here rather than a silent fall-through. */
const SCHEMA_METRIC_KEYS: Record<SchemaTableMetric, string> = {
  none: "menu.view.metricHide",
  "row-count": "menu.view.metricRowCount",
  size: "menu.view.metricSize",
  both: "menu.view.metricBoth",
};

/** Preference-store writers the registry needs to flip a boolean. */
export interface PrefsWriters {
  updateEditor: (patch: Partial<Preferences["editor"]>) => void;
  updateGrid: (patch: Partial<Preferences["grid"]>) => void;
  updateUi: (patch: Partial<Preferences["ui"]>) => void;
  updateNotifications: (patch: Partial<Preferences["notifications"]>) => void;
  updateConnections: (patch: Partial<Preferences["connections"]>) => void;
  updatePulse: (patch: Partial<Preferences["pulse"]>) => void;
  updateAi: (patch: Partial<Preferences["ai"]>) => void;
  updateUpdates: (patch: Partial<Preferences["updates"]>) => void;
  updateTerminal: (patch: Partial<Preferences["terminal"]>) => void;
  updateLock: (patch: Partial<Preferences["lock"]>) => void;
}

export interface SettingEntry {
  /** Anchor id — mirrors the `prefId` on the setting's `PrefRow`. */
  prefId: PrefId;
  section: SettingsSection;
  /** i18n key of the row's label. */
  labelKey: string;
  /** i18n key of the row's description, when it has one. */
  descKey?: string;
  /** Extra match text (English + Spanish), never displayed. */
  keywords?: string;
  /** Current value as a short badge. `raw` values are printed verbatim. */
  value?: (prefs: Preferences) => { raw?: string; i18nKey?: string } | undefined;
  /** Boolean settings only: flip the value in place. */
  toggle?: (prefs: Preferences, writers: PrefsWriters) => void;
}

/** Shorthand for the on/off badge every boolean shares. */
const onOff = (read: (p: Preferences) => boolean) => (p: Preferences) => ({
  i18nKey: read(p) ? "commandPalette.settings.on" : "commandPalette.settings.off",
});

const num = (read: (p: Preferences) => number) => (p: Preferences) => ({
  raw: String(read(p)),
});

const text = (read: (p: Preferences) => string) => (p: Preferences) => ({
  raw: read(p),
});

export const SETTINGS_INDEX: SettingEntry[] = [
  // ── General ───────────────────────────────────────────────────────────────
  {
    prefId: "ui.language",
    section: "general",
    labelKey: "common.language",
    descKey: "common.languageDescription",
    keywords: "language idioma locale english spanish inglés español",
    value: (p) => ({
      i18nKey:
        p.ui.language === "es" ? "common.languageSpanish" : "common.languageEnglish",
    }),
  },
  {
    prefId: "ui.defaultDriver",
    section: "general",
    labelKey: "settings.general.defaultDriver.label",
    descKey: "settings.general.defaultDriver.desc",
    keywords: "driver motor postgres mysql sqlite mongodb sqlserver default",
    value: (p) =>
      p.ui.defaultDriver
        ? { raw: p.ui.defaultDriver }
        : { i18nKey: "settings.general.defaultDriver.ask" },
  },
  {
    prefId: "ui.confirmDestructive",
    section: "general",
    labelKey: "settings.general.confirmDestructive.label",
    descKey: "settings.general.confirmDestructive.desc",
    keywords: "confirm destructive delete drop confirmar destructivo borrar",
    value: onOff((p) => p.ui.confirmDestructive),
    toggle: (p, w) => w.updateUi({ confirmDestructive: !p.ui.confirmDestructive }),
  },
  {
    prefId: "ui.restoreTabsOnOpen",
    section: "general",
    labelKey: "settings.general.restoreTabs.label",
    descKey: "settings.general.restoreTabs.desc",
    keywords: "restore tabs session restaurar pestañas sesión",
    value: onOff((p) => p.ui.restoreTabsOnOpen),
    toggle: (p, w) => w.updateUi({ restoreTabsOnOpen: !p.ui.restoreTabsOnOpen }),
  },
  {
    prefId: "ui.reconnectOnLaunch",
    section: "general",
    labelKey: "settings.general.reconnectOnLaunch.label",
    descKey: "settings.general.reconnectOnLaunch.desc",
    keywords: "reconnect launch startup reconectar arranque inicio",
    value: onOff((p) => p.ui.reconnectOnLaunch),
    toggle: (p, w) => w.updateUi({ reconnectOnLaunch: !p.ui.reconnectOnLaunch }),
  },
  // Windows only, like its row in `GeneralSection`: elsewhere the palette would
  // offer a jump to a setting that is not on the page.
  ...(isWindows()
    ? [
        {
          prefId: "ui.jumpListRecent",
          section: "general",
          labelKey: "settings.general.jumpListRecent.label",
          descKey: "settings.general.jumpListRecent.desc",
          keywords:
            "jump list taskbar recent connections right click lista de saltos barra de tareas recientes clic derecho",
          value: onOff((p) => p.ui.jumpListRecent),
          toggle: (p, w) => w.updateUi({ jumpListRecent: !p.ui.jumpListRecent }),
        } satisfies SettingEntry,
      ]
    : []),
  {
    prefId: "ui.cellEditorMode",
    section: "general",
    labelKey: "settings.general.cellEditorMode.label",
    descKey: "settings.general.cellEditorMode.desc",
    keywords: "cell editor modal side panel celda editor lateral",
    value: (p) => ({
      i18nKey: `settings.general.cellEditorMode.${p.ui.cellEditorMode}`,
    }),
  },
  {
    prefId: "ui.connectionGroupExpandMode",
    section: "general",
    labelKey: "settings.general.connectionGroupExpandMode.label",
    descKey: "settings.general.connectionGroupExpandMode.desc",
    keywords: "groups folders expand collapse grupos carpetas plegar",
    value: (p) => ({
      i18nKey: `settings.general.connectionGroupExpandMode.${p.ui.connectionGroupExpandMode}`,
    }),
  },
  {
    prefId: "ui.queryHistoryLimit",
    section: "general",
    labelKey: "settings.general.queryHistoryLimit.label",
    descKey: "settings.general.queryHistoryLimit.desc",
    keywords: "history limit historial límite consultas",
    value: num((p) => p.ui.queryHistoryLimit),
  },

  // ── Editor ────────────────────────────────────────────────────────────────
  {
    prefId: "editor.theme",
    section: "editor",
    labelKey: "settings.editor.theme",
    keywords: "monaco editor theme colours tema colores syntax",
    value: text((p) => p.editor.theme),
  },
  {
    prefId: "editor.fontFamily",
    section: "editor",
    labelKey: "settings.editor.fontFamily",
    keywords: "font family typeface fuente tipografía mono",
    value: text((p) => p.editor.fontFamily),
  },
  {
    prefId: "editor.fontSize",
    section: "editor",
    labelKey: "settings.editor.fontSize",
    keywords: "font size zoom tamaño fuente",
    value: num((p) => p.editor.fontSize),
  },
  {
    prefId: "editor.tabSize",
    section: "editor",
    labelKey: "settings.editor.tabSize",
    keywords: "tab size indent tabulación sangría",
    value: num((p) => p.editor.tabSize),
  },
  {
    prefId: "editor.wordWrap",
    section: "editor",
    labelKey: "settings.editor.wordWrap.label",
    descKey: "settings.editor.wordWrap.desc",
    keywords: "word wrap soft wrap ajuste de línea envolver",
    value: onOff((p) => p.editor.wordWrap),
    toggle: (p, w) => w.updateEditor({ wordWrap: !p.editor.wordWrap }),
  },
  {
    prefId: "editor.minimap",
    section: "editor",
    labelKey: "settings.editor.minimap.label",
    descKey: "settings.editor.minimap.desc",
    keywords: "minimap overview minimapa",
    value: onOff((p) => p.editor.minimap),
    toggle: (p, w) => w.updateEditor({ minimap: !p.editor.minimap }),
  },
  {
    prefId: "editor.lineNumbers",
    section: "editor",
    labelKey: "settings.editor.lineNumbers",
    keywords: "line numbers gutter números de línea",
    value: onOff((p) => p.editor.lineNumbers),
    toggle: (p, w) => w.updateEditor({ lineNumbers: !p.editor.lineNumbers }),
  },
  {
    prefId: "editor.formatOnPaste",
    section: "editor",
    labelKey: "settings.editor.formatOnPaste.label",
    descKey: "settings.editor.formatOnPaste.desc",
    keywords: "format paste formatear pegar",
    value: onOff((p) => p.editor.formatOnPaste),
    toggle: (p, w) => w.updateEditor({ formatOnPaste: !p.editor.formatOnPaste }),
  },
  {
    prefId: "editor.autoFormatJson",
    section: "editor",
    labelKey: "settings.editor.autoFormatJson.label",
    descKey: "settings.editor.autoFormatJson.desc",
    keywords:
      "auto format json open cell beautify pretty print formatear automático abrir celda embellecer",
    value: onOff((p) => p.editor.autoFormatJson),
    toggle: (p, w) => w.updateEditor({ autoFormatJson: !p.editor.autoFormatJson }),
  },
  {
    prefId: "editor.autoFormatXml",
    section: "editor",
    labelKey: "settings.editor.autoFormatXml.label",
    descKey: "settings.editor.autoFormatXml.desc",
    keywords:
      "auto format xml open cell indent formatear automático abrir celda indentar sangrar",
    value: onOff((p) => p.editor.autoFormatXml),
    toggle: (p, w) => w.updateEditor({ autoFormatXml: !p.editor.autoFormatXml }),
  },
  {
    prefId: "editor.autoFormatSql",
    section: "editor",
    labelKey: "settings.editor.autoFormatSql.label",
    descKey: "settings.editor.autoFormatSql.desc",
    keywords:
      "auto format sql open cell query dialect formatear automático abrir celda consulta dialecto",
    value: onOff((p) => p.editor.autoFormatSql),
    toggle: (p, w) => w.updateEditor({ autoFormatSql: !p.editor.autoFormatSql }),
  },

  // ── Data grid ─────────────────────────────────────────────────────────────
  {
    prefId: "grid.defaultPageSize",
    section: "grid",
    labelKey: "settings.grid.defaultPageSize",
    keywords: "page size rows limit paginación filas",
    value: num((p) => p.grid.defaultPageSize),
  },
  {
    prefId: "grid.rowHeight",
    section: "grid",
    labelKey: "settings.grid.rowHeight",
    keywords: "row height density zoom altura fila densidad",
    value: num((p) => p.grid.rowHeight),
  },
  {
    prefId: "grid.nullDisplay",
    section: "grid",
    labelKey: "settings.grid.nullDisplay.label",
    descKey: "settings.grid.nullDisplay.desc",
    keywords: "null display placeholder nulo",
    value: text((p) => p.grid.nullDisplay),
  },
  {
    prefId: "grid.truncateLongTextAt",
    section: "grid",
    labelKey: "settings.grid.truncateLongTextAt.label",
    descKey: "settings.grid.truncateLongTextAt.desc",
    keywords: "truncate long text chars truncar texto largo",
    value: num((p) => p.grid.truncateLongTextAt),
  },
  {
    prefId: "grid.zebraStripes",
    section: "grid",
    labelKey: "settings.grid.zebraStripes.label",
    descKey: "settings.grid.zebraStripes.desc",
    keywords: "zebra stripes alternate rows cebra rayas",
    value: onOff((p) => p.grid.zebraStripes),
    toggle: (p, w) => w.updateGrid({ zebraStripes: !p.grid.zebraStripes }),
  },
  {
    prefId: "grid.stickyHeader",
    section: "grid",
    labelKey: "settings.grid.stickyHeader.label",
    descKey: "settings.grid.stickyHeader.desc",
    keywords: "sticky header freeze cabecera fija",
    value: onOff((p) => p.grid.stickyHeader),
    toggle: (p, w) => w.updateGrid({ stickyHeader: !p.grid.stickyHeader }),
  },
  {
    prefId: "grid.cellPreview",
    section: "grid",
    labelKey: "settings.grid.cellPreview.label",
    descKey: "settings.grid.cellPreview.desc",
    keywords: "cell preview panel vista previa celda",
    value: onOff((p) => p.grid.cellPreview),
    toggle: (p, w) => w.updateGrid({ cellPreview: !p.grid.cellPreview }),
  },
  {
    prefId: "grid.bitDisplay",
    section: "grid",
    labelKey: "settings.grid.bitDisplay.label",
    descKey: "settings.grid.bitDisplay.desc",
    keywords: "bit boolean display mysql true false",
    value: (p) => ({
      i18nKey:
        p.grid.bitDisplay === "zero_one"
          ? "settings.grid.bitDisplay.zeroOne"
          : "settings.grid.bitDisplay.trueFalse",
    }),
  },
  {
    prefId: "ui.schemaTableMetric",
    section: "grid",
    labelKey: "settings.grid.schemaMetric.label",
    descKey: "settings.grid.schemaMetric.desc",
    keywords: "schema metric row count size métrica esquema tamaño",
    // A `Record` rather than the ternary chain this was: the chain needed a
    // new branch per value and silently fell through to "hide" for one it did
    // not know, whereas a total map is a compile error until the new value is
    // named.
    value: (p) => ({ i18nKey: SCHEMA_METRIC_KEYS[p.ui.schemaTableMetric] }),
  },
  {
    prefId: "ui.tabAccentStyle",
    section: "grid",
    labelKey: "settings.grid.tabAccentStyle.label",
    descKey: "settings.grid.tabAccentStyle.desc",
    keywords: "tab accent style cap rail boxed pestaña acento",
    value: (p) => ({
      i18nKey: `settings.grid.tabAccentStyle.${p.ui.tabAccentStyle}`,
    }),
  },

  // ── Notifications ─────────────────────────────────────────────────────────
  {
    prefId: "notifications.position",
    section: "notifications",
    labelKey: "settings.notifications.position.label",
    descKey: "settings.notifications.position.desc",
    keywords:
      "notification toast position corner posición esquina notificación aviso bottom right top",
    value: (p) => ({
      i18nKey: `settings.notifications.position.${POSITION_LABEL_KEYS[p.notifications.position]}`,
    }),
  },
  {
    prefId: "notifications.pillPosition",
    section: "notifications",
    labelKey: "settings.notifications.pillPosition.label",
    descKey: "settings.notifications.pillPosition.desc",
    keywords:
      "notification pill position corner píldora posición esquina aviso confirmación bottom center",
    // The corner labels are shared with the card row on purpose: there is one
    // set of six corners, and a second spelling of "Bottom centre" is a second
    // thing to keep translated.
    value: (p) => ({
      i18nKey: `settings.notifications.position.${POSITION_LABEL_KEYS[p.notifications.pillPosition]}`,
    }),
  },
  {
    prefId: "notifications.durationMs",
    section: "notifications",
    labelKey: "settings.notifications.duration.label",
    descKey: "settings.notifications.duration.desc",
    keywords: "notification duration seconds duración segundos tiempo toast",
    value: (p) =>
      p.notifications.durationMs > 0
        ? { raw: `${Math.round(p.notifications.durationMs / 100) / 10} s` }
        : { i18nKey: "settings.notifications.duration.sticky" },
  },
  {
    prefId: "notifications.errorsPersist",
    section: "notifications",
    labelKey: "settings.notifications.errorsPersist.label",
    descKey: "settings.notifications.errorsPersist.desc",
    keywords: "error persist dismiss errores persistentes cerrar",
    value: onOff((p) => p.notifications.errorsPersist),
    toggle: (p, w) =>
      w.updateNotifications({ errorsPersist: !p.notifications.errorsPersist }),
  },
  {
    prefId: "notifications.maxVisible",
    section: "notifications",
    labelKey: "settings.notifications.maxVisible.label",
    descKey: "settings.notifications.maxVisible.desc",
    keywords: "notification stack visible pila visibles apiladas",
    value: num((p) => p.notifications.maxVisible),
  },
  {
    prefId: "notifications.expandOnHover",
    section: "notifications",
    labelKey: "settings.notifications.expandOnHover.label",
    descKey: "settings.notifications.expandOnHover.desc",
    keywords: "expand hover stack expandir ratón pila",
    value: onOff((p) => p.notifications.expandOnHover),
    toggle: (p, w) =>
      w.updateNotifications({ expandOnHover: !p.notifications.expandOnHover }),
  },
  {
    prefId: "notifications.density",
    section: "notifications",
    labelKey: "settings.notifications.density.label",
    descKey: "settings.notifications.density.desc",
    keywords: "density compact comfortable densidad compacta cómoda",
    value: (p) => ({
      i18nKey: `settings.notifications.density.${p.notifications.density}`,
    }),
  },
  {
    prefId: "notifications.historyLimit",
    section: "notifications",
    labelKey: "settings.notifications.historyLimit.label",
    descKey: "settings.notifications.historyLimit.desc",
    keywords: "notification history limit historial límite campana",
    value: num((p) => p.notifications.historyLimit),
  },
  {
    prefId: "notifications.showBell",
    section: "notifications",
    labelKey: "settings.notifications.showBell.label",
    descKey: "settings.notifications.showBell.desc",
    keywords: "bell status bar campana barra estado historial",
    value: onOff((p) => p.notifications.showBell),
    toggle: (p, w) => w.updateNotifications({ showBell: !p.notifications.showBell }),
  },

  // ── Connections ───────────────────────────────────────────────────────────
  {
    prefId: "connections.maxConnections",
    section: "connections",
    labelKey: "settings.connections.maxConnections.label",
    descKey: "settings.connections.maxConnections.desc",
    keywords: "pool max connections límite conexiones",
    value: num((p) => p.connections.maxConnections),
  },
  {
    prefId: "connections.operationTimeoutSecs",
    section: "connections",
    labelKey: "settings.connections.operationTimeout.label",
    descKey: "settings.connections.operationTimeout.desc",
    keywords: "timeout tiempo espera esquema metadata introspección lento",
    value: num((p) => p.connections.operationTimeoutSecs),
  },
  {
    prefId: "connections.childMaxConnections",
    section: "connections",
    labelKey: "settings.connections.childMaxConnections.label",
    descKey: "settings.connections.childMaxConnections.desc",
    keywords: "pool database view child límite vista base de datos",
    value: num((p) => p.connections.childMaxConnections),
  },
  {
    prefId: "connections.maxChildPools",
    section: "connections",
    labelKey: "settings.connections.maxChildPools.label",
    descKey: "settings.connections.maxChildPools.desc",
    keywords: "database views open límite vistas abiertas",
    value: num((p) => p.connections.maxChildPools),
  },
  {
    prefId: "connections.childIdleTtlSecs",
    section: "connections",
    labelKey: "settings.connections.childIdleTtl.label",
    descKey: "settings.connections.childIdleTtl.desc",
    keywords: "idle ttl close reap inactividad cerrar",
    value: num((p) => p.connections.childIdleTtlSecs),
  },
  {
    prefId: "connections.bridgeIdleTtlSecs",
    section: "connections",
    labelKey: "settings.connections.bridgeIdleTtl.label",
    descKey: "settings.connections.bridgeIdleTtl.desc",
    keywords: "mcp bridge idle ttl close reap conector inactividad cerrar",
    value: num((p) => p.connections.bridgeIdleTtlSecs),
  },
  {
    prefId: "connections.keepaliveSecs",
    section: "connections",
    labelKey: "settings.connections.keepalive.label",
    descKey: "settings.connections.keepalive.desc",
    keywords: "keepalive ping heartbeat latido",
    value: num((p) => p.connections.keepaliveSecs),
  },
  {
    prefId: "connections.mcpBridge",
    section: "connections",
    labelKey: "settings.connections.mcpBridge.label",
    descKey: "settings.connections.mcpBridge.desc",
    keywords: "mcp bridge sidecar ai share pools puente",
    value: onOff((p) => p.connections.mcpBridge),
    toggle: (p, w) => w.updateConnections({ mcpBridge: !p.connections.mcpBridge }),
  },

  {
    prefId: "connections.mcpMaxRows",
    section: "mcp",
    labelKey: "settings.mcp.maxRows.label",
    descKey: "settings.mcp.maxRows.desc",
    keywords: "mcp rows limit max filas límite tope truncar ai ia",
    value: num((p) => p.connections.mcpMaxRows),
  },

  // ── Appearance → data view ────────────────────────────────────────────────
  {
    prefId: "grid.documentViewMode",
    section: "appearance",
    labelKey: "settings.appearance.dataView.mode.label",
    descKey: "settings.appearance.dataView.mode.desc",
    keywords: "row layout table list card vista fila tabla lista",
    value: (p) => ({
      i18nKey: `settings.appearance.dataView.mode.${p.grid.documentViewMode}`,
    }),
    // Only two states, so the toggle is a genuine flip rather than a cycle.
    toggle: (p, w) =>
      w.updateGrid({
        documentViewMode: p.grid.documentViewMode === "list" ? "table" : "list",
      }),
  },
  {
    prefId: "grid.listExpandNested",
    section: "appearance",
    labelKey: "settings.appearance.dataView.expandNested.label",
    descKey: "settings.appearance.dataView.expandNested.desc",
    keywords: "expand nested objects arrays desplegar anidado",
    value: onOff((p) => p.grid.listExpandNested),
    toggle: (p, w) => w.updateGrid({ listExpandNested: !p.grid.listExpandNested }),
  },
  {
    prefId: "grid.listShowTypes",
    section: "appearance",
    labelKey: "settings.appearance.dataView.showTypes.label",
    descKey: "settings.appearance.dataView.showTypes.desc",
    keywords: "field types gutter tipos campo",
    value: onOff((p) => p.grid.listShowTypes),
    toggle: (p, w) => w.updateGrid({ listShowTypes: !p.grid.listShowTypes }),
  },
  {
    prefId: "grid.listLineNumbers",
    section: "appearance",
    labelKey: "settings.appearance.dataView.lineNumbers.label",
    descKey: "settings.appearance.dataView.lineNumbers.desc",
    keywords: "number fields gutter numerar campos",
    value: onOff((p) => p.grid.listLineNumbers),
    toggle: (p, w) => w.updateGrid({ listLineNumbers: !p.grid.listLineNumbers }),
  },

  // --- JSON Schemas ------------------------------------------------------
  // Their `section` is "jsonSchemas" rather than "editor" because that is where
  // the `PrefRow`s live, and `prefId` is the whole join between the two — a typo
  // degrades silently to "the section opens, nothing is highlighted".
  {
    prefId: "editor.jsonSchemaValidation",
    section: "jsonSchemas",
    labelKey: "jsonSchemas.prefs.validation.label",
    descKey: "jsonSchemas.prefs.validation.desc",
    keywords:
      "json schema validation validate squiggle errors esquema json validacion validar errores subrayado",
    value: onOff((p) => p.editor.jsonSchemaValidation),
    toggle: (p, w) =>
      w.updateEditor({ jsonSchemaValidation: !p.editor.jsonSchemaValidation }),
  },
  {
    prefId: "editor.jsonSchemaCompletion",
    section: "jsonSchemas",
    labelKey: "jsonSchemas.prefs.completion.label",
    descKey: "jsonSchemas.prefs.completion.desc",
    keywords:
      "json schema autocomplete completion suggestions intellisense esquema json autocompletado sugerencias",
    value: onOff((p) => p.editor.jsonSchemaCompletion),
    toggle: (p, w) =>
      w.updateEditor({ jsonSchemaCompletion: !p.editor.jsonSchemaCompletion }),
  },
  {
    prefId: "editor.jsonSchemaHover",
    section: "jsonSchemas",
    labelKey: "jsonSchemas.prefs.hover.label",
    descKey: "jsonSchemas.prefs.hover.desc",
    keywords:
      "json schema hover tooltip documentation description esquema json descripcion ayuda contextual",
    value: onOff((p) => p.editor.jsonSchemaHover),
    toggle: (p, w) => w.updateEditor({ jsonSchemaHover: !p.editor.jsonSchemaHover }),
  },

  // ── Pulse ─────────────────────────────────────────────────────────────────
  {
    prefId: "pulse.historyIntervalSecs",
    section: "pulse",
    labelKey: "settings.pulse.historyIntervalSecs.label",
    descKey: "settings.pulse.historyIntervalSecs.desc",
    keywords: "pulse sampler history interval tick historial muestreo intervalo",
    value: num((p) => p.pulse.historyIntervalSecs),
  },
  {
    prefId: "pulse.retentionDays",
    section: "pulse",
    labelKey: "settings.pulse.retentionDays.label",
    descKey: "settings.pulse.retentionDays.desc",
    keywords: "pulse retention days history retención días historial",
    value: num((p) => p.pulse.retentionDays),
  },
  {
    prefId: "pulse.maxDiskMb",
    section: "pulse",
    labelKey: "settings.pulse.maxDiskMb.label",
    descKey: "settings.pulse.maxDiskMb.desc",
    keywords: "pulse disk size cap disco tamaño límite",
    value: num((p) => p.pulse.maxDiskMb),
  },
  {
    prefId: "pulse.enabled",
    section: "pulse",
    labelKey: "settings.pulse.enabled.label",
    descKey: "settings.pulse.enabled.desc",
    keywords: "pulse monitoring module show hide icon monitorización módulo mostrar ocultar icono",
    value: onOff((p) => p.pulse.enabled),
    toggle: (p, w) => w.updatePulse({ enabled: !p.pulse.enabled }),
  },
  {
    prefId: "pulse.sampleWhenMinimized",
    section: "pulse",
    labelKey: "settings.pulse.sampleWhenMinimized.label",
    descKey: "settings.pulse.sampleWhenMinimized.desc",
    keywords: "pulse minimized background minimizado segundo plano",
    value: onOff((p) => p.pulse.sampleWhenMinimized),
    toggle: (p, w) =>
      w.updatePulse({ sampleWhenMinimized: !p.pulse.sampleWhenMinimized }),
  },

  // ── Updates ───────────────────────────────────────────────────────────────
  {
    prefId: "updates.autoInstall",
    section: "about",
    labelKey: "update.autoInstall.label",
    descKey: "update.autoInstall.desc",
    keywords:
      "update automatic background silent scheduled task actualización automática segundo plano tarea programada",
    value: onOff((p) => p.updates.autoInstall),
    toggle: (p, w) => w.updateUpdates({ autoInstall: !p.updates.autoInstall }),
  },

  // ── Security ──────────────────────────────────────────────────────────────
  {
    prefId: "lock.idleMinutes",
    section: "security",
    labelKey: "settings.security.idleMinutes.label",
    descKey: "settings.security.idleMinutes.desc",
    keywords:
      "lock idle inactivity timeout minutes master password vault bloqueo inactividad minutos contraseña maestra",
    value: num((p) => p.lock.idleMinutes),
  },
  {
    prefId: "lock.withSession",
    section: "security",
    labelKey: "settings.security.withSession.label",
    descKey: "settings.security.withSession.desc",
    keywords:
      "lock session windows win+l remote desktop disconnect logind bloqueo sesión escritorio remoto desconectar",
    value: onOff((p) => p.lock.withSession),
    toggle: (p, w) => w.updateLock({ withSession: !p.lock.withSession }),
  },

  // ── Terminal ──────────────────────────────────────────────────────────────
  {
    prefId: "terminal.enabled",
    section: "terminal",
    labelKey: "settings.terminal.enabled.label",
    descKey: "settings.terminal.enabled.desc",
    keywords:
      "terminal mongosh shell console powershell bash module icon terminal consola módulo icono",
    value: onOff((p) => p.terminal.enabled),
    toggle: (p, w) => w.updateTerminal({ enabled: !p.terminal.enabled }),
  },
  {
    prefId: "terminal.mongoshPath",
    section: "terminal",
    labelKey: "settings.terminal.mongoshPath.label",
    descKey: "settings.terminal.mongoshPath.desc",
    keywords: "mongosh mongo shell path executable ruta ejecutable",
    value: text((p) => p.terminal.mongoshPath),
  },
  {
    prefId: "terminal.shellPath",
    section: "terminal",
    labelKey: "settings.terminal.shellPath.label",
    descKey: "settings.terminal.shellPath.desc",
    keywords: "shell powershell pwsh bash zsh path ruta intérprete",
    value: text((p) => p.terminal.shellPath),
  },

  // ── AI ────────────────────────────────────────────────────────────────────
  {
    prefId: "ai.enabled",
    section: "ai",
    labelKey: "settings.ai.enabled.label",
    descKey: "settings.ai.enabled.desc",
    keywords: "ai assistant llm model chat ia asistente modelo",
    value: onOff((p) => p.ai.enabled),
    toggle: (p, w) => w.updateAi({ enabled: !p.ai.enabled }),
  },
  {
    prefId: "ai.baseUrl",
    section: "ai",
    labelKey: "settings.ai.baseUrl.label",
    descKey: "settings.ai.baseUrl.desc",
    keywords:
      "ai endpoint url ollama lm studio llama vllm openrouter local ia endpoint local",
    value: text((p) => p.ai.baseUrl),
  },
  {
    prefId: "ai.model",
    section: "ai",
    labelKey: "settings.ai.model.label",
    descKey: "settings.ai.model.desc",
    keywords: "ai model llm ia modelo",
    value: text((p) => p.ai.model),
  },
  {
    prefId: "ai.endpointTrust",
    section: "ai",
    labelKey: "settings.ai.trust.label",
    descKey: "settings.ai.trust.desc",
    keywords:
      "ai trust endpoint rows privacy local infrastructure ia confianza filas privacidad infraestructura",
    value: (p) => ({
      i18nKey:
        p.ai.endpointTrust === "trusted"
          ? "settings.ai.trust.trusted"
          : "settings.ai.trust.untrusted",
    }),
  },
  {
    prefId: "ai.mode",
    section: "ai",
    labelKey: "settings.ai.mode.label",
    descKey: "settings.ai.mode.desc",
    keywords: "ai mode assisted agent tools ia modo asistido agente herramientas",
    value: (p) => ({
      i18nKey:
        p.ai.mode === "agent"
          ? "settings.ai.mode.agent"
          : "settings.ai.mode.assisted",
    }),
  },
  {
    prefId: "ai.maxContextRows",
    section: "ai",
    labelKey: "settings.ai.maxContextRows.label",
    descKey: "settings.ai.maxContextRows.desc",
    keywords: "ai rows context budget limit ia filas contexto limite",
    value: num((p) => p.ai.maxContextRows),
  },
  {
    prefId: "ai.reasoningEffort",
    section: "ai",
    labelKey: "settings.ai.reasoningEffort.label",
    descKey: "settings.ai.reasoningEffort.desc",
    keywords:
      "ai reasoning effort thinking think ia razonamiento pensar esfuerzo",
    value: (p) => ({ i18nKey: `ai.effort.level.${p.ai.reasoningEffort}` }),
  },
  {
    prefId: "ai.requestTimeoutSecs",
    section: "ai",
    labelKey: "settings.ai.requestTimeoutSecs.label",
    descKey: "settings.ai.requestTimeoutSecs.desc",
    keywords: "ai timeout idle seconds ia tiempo espera segundos",
    value: num((p) => p.ai.requestTimeoutSecs),
  },
];
