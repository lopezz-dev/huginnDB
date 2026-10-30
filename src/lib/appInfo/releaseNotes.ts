/**
 * Curated "What's new" content — the highlights shown in the post-update
 * {@link WhatsNewDialog} presentation.
 *
 * This is a hand-authored, bundled catalogue (no runtime CHANGELOG parsing):
 * each entry lists a few user-facing highlights for one release, and only
 * entries flagged `major` pop the dialog automatically on the first launch
 * after updating to that version (see `stores/whatsNew.ts`). Non-major
 * releases can still carry an entry — it just won't auto-present; it's only
 * reachable via Help → "What's new".
 *
 * Copy lives in i18n (`whatsNew.releases.<key>.*` in en.json / es.json), so
 * the strings here are only the *keys*. The icon is a lucide component
 * rendered in a brand-tinted chip.
 *
 * CONTRACT: `version` must EXACTLY equal the app version the release ships as
 * (the `version` in `tauri.conf.json` / `package.json`, i.e. what
 * `getVersion()` returns at runtime) — the auto-trigger matches on an exact
 * string compare. When you cut a release, bump BOTH the manifest version and
 * the newest entry's `version` here (and its i18n keys) together.
 */

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AppWindow,
  ArrowUpDown,
  Bell,
  Bot,
  Braces,
  Bug,
  BookOpen,
  Building2,
  ClipboardPaste,
  Coins,
  Columns3,
  Copy,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode,
  FileInput,
  FilePen,
  FolderTree,
  ImagePlus,
  Gauge,
  HardDrive,
  Keyboard,
  KeyRound,
  Layers,
  LayoutList,
  ListChecks,
  ListFilter,
  ListTree,
  Lock,
  MonitorOff,
  Package,
  Palette,
  PanelTop,
  Pencil,
  Plug,
  Power,
  RefreshCw,
  Scissors,
  ScrollText,
  Search,
  Server,
  Settings2,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Sigma,
  SlidersHorizontal,
  SquareTerminal,
  Table2,
  TableProperties,
  Tags,
  Target,
  Timer,
  Trash2,
  Wand2,
} from "lucide-react";

export interface ReleaseHighlight {
  /** lucide icon shown in the highlight's chip. */
  icon: LucideIcon;
  /** i18n key for the highlight's short title. */
  titleKey: string;
  /** i18n key for the highlight's one-line body. */
  bodyKey: string;
}

export interface ReleaseNote {
  /** App version this note describes — must match `getVersion()` exactly. */
  version: string;
  /**
   * When true, the first launch on this version auto-presents the dialog.
   * This is the "big changes / new system" flag the presentation keys off.
   */
  major: boolean;
  /** i18n key for the release's one-line tagline under the title. */
  taglineKey: string;
  highlights: ReleaseHighlight[];
}

/**
 * Newest first. The auto-trigger only ever looks at the entry whose `version`
 * equals the running version; the ordering matters for `latestReleaseNote()`
 * (the manual Help entry) and for any future "history" view.
 */
export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "1.37.0",
    major: true,
    taglineKey: "whatsNew.releases.1_37_0.tagline",
    highlights: [
      {
        icon: TableProperties,
        titleKey: "whatsNew.releases.1_37_0.items.mssqlStructure.title",
        bodyKey: "whatsNew.releases.1_37_0.items.mssqlStructure.body",
      },
      {
        icon: FileCode,
        titleKey: "whatsNew.releases.1_37_0.items.mssqlDump.title",
        bodyKey: "whatsNew.releases.1_37_0.items.mssqlDump.body",
      },
      {
        icon: ScrollText,
        titleKey: "whatsNew.releases.1_37_0.items.runScript.title",
        bodyKey: "whatsNew.releases.1_37_0.items.runScript.body",
      },
      {
        icon: SlidersHorizontal,
        titleKey: "whatsNew.releases.1_37_0.items.rowLimit.title",
        bodyKey: "whatsNew.releases.1_37_0.items.rowLimit.body",
      },
      {
        icon: Sigma,
        titleKey: "whatsNew.releases.1_37_0.items.exactCount.title",
        bodyKey: "whatsNew.releases.1_37_0.items.exactCount.body",
      },
      {
        icon: KeyRound,
        titleKey: "whatsNew.releases.1_37_0.items.mongoPassword.title",
        bodyKey: "whatsNew.releases.1_37_0.items.mongoPassword.body",
      },
    ],
  },
  {
    version: "1.36.0",
    major: true,
    taglineKey: "whatsNew.releases.1_36_0.tagline",
    highlights: [
      {
        icon: Lock,
        titleKey: "whatsNew.releases.1_36_0.items.appLock.title",
        bodyKey: "whatsNew.releases.1_36_0.items.appLock.body",
      },
      {
        icon: MonitorOff,
        titleKey: "whatsNew.releases.1_36_0.items.lockWithSession.title",
        bodyKey: "whatsNew.releases.1_36_0.items.lockWithSession.body",
      },
      {
        icon: ClipboardPaste,
        titleKey: "whatsNew.releases.1_36_0.items.pasteBlock.title",
        bodyKey: "whatsNew.releases.1_36_0.items.pasteBlock.body",
      },
      {
        icon: Columns3,
        titleKey: "whatsNew.releases.1_36_0.items.columnLimits.title",
        bodyKey: "whatsNew.releases.1_36_0.items.columnLimits.body",
      },
      {
        icon: FileInput,
        titleKey: "whatsNew.releases.1_36_0.items.aiProfileImport.title",
        bodyKey: "whatsNew.releases.1_36_0.items.aiProfileImport.body",
      },
      {
        icon: KeyRound,
        titleKey: "whatsNew.releases.1_36_0.items.sshRsa.title",
        bodyKey: "whatsNew.releases.1_36_0.items.sshRsa.body",
      },
    ],
  },
  {
    version: "1.35.0",
    major: true,
    taglineKey: "whatsNew.releases.1_35_0.tagline",
    highlights: [
      {
        icon: Layers,
        titleKey: "whatsNew.releases.1_35_0.items.batchReads.title",
        bodyKey: "whatsNew.releases.1_35_0.items.batchReads.body",
      },
      {
        icon: ListChecks,
        titleKey: "whatsNew.releases.1_35_0.items.batchWrites.title",
        bodyKey: "whatsNew.releases.1_35_0.items.batchWrites.body",
      },
      {
        icon: Coins,
        titleKey: "whatsNew.releases.1_35_0.items.fewerTokens.title",
        bodyKey: "whatsNew.releases.1_35_0.items.fewerTokens.body",
      },
      {
        icon: Scissors,
        titleKey: "whatsNew.releases.1_35_0.items.truncatedResults.title",
        bodyKey: "whatsNew.releases.1_35_0.items.truncatedResults.body",
      },
    ],
  },
  {
    version: "1.34.0",
    major: true,
    taglineKey: "whatsNew.releases.1_34_0.tagline",
    highlights: [
      {
        icon: SquareTerminal,
        titleKey: "whatsNew.releases.1_34_0.items.terminalMongosh.title",
        bodyKey: "whatsNew.releases.1_34_0.items.terminalMongosh.body",
      },
      {
        icon: Download,
        titleKey: "whatsNew.releases.1_34_0.items.mongoshDownload.title",
        bodyKey: "whatsNew.releases.1_34_0.items.mongoshDownload.body",
      },
      {
        icon: ListTree,
        titleKey: "whatsNew.releases.1_34_0.items.largeSchemas.title",
        bodyKey: "whatsNew.releases.1_34_0.items.largeSchemas.body",
      },
      {
        icon: ShieldCheck,
        titleKey: "whatsNew.releases.1_34_0.items.sshGentler.title",
        bodyKey: "whatsNew.releases.1_34_0.items.sshGentler.body",
      },
      {
        icon: EyeOff,
        titleKey: "whatsNew.releases.1_34_0.items.hidePanels.title",
        bodyKey: "whatsNew.releases.1_34_0.items.hidePanels.body",
      },
    ],
  },
  {
    version: "1.33.0",
    major: true,
    taglineKey: "whatsNew.releases.1_33_0.tagline",
    highlights: [
      {
        icon: Package,
        titleKey: "whatsNew.releases.1_33_0.items.appImageMcp.title",
        bodyKey: "whatsNew.releases.1_33_0.items.appImageMcp.body",
      },
      {
        icon: Wand2,
        titleKey: "whatsNew.releases.1_33_0.items.registrationRepair.title",
        bodyKey: "whatsNew.releases.1_33_0.items.registrationRepair.body",
      },
      {
        icon: Plug,
        titleKey: "whatsNew.releases.1_33_0.items.mcpEditedConnection.title",
        bodyKey: "whatsNew.releases.1_33_0.items.mcpEditedConnection.body",
      },
      {
        icon: Pencil,
        titleKey: "whatsNew.releases.1_33_0.items.editedConnectionFlagged.title",
        bodyKey: "whatsNew.releases.1_33_0.items.editedConnectionFlagged.body",
      },
    ],
  },
  {
    version: "1.32.0",
    major: true,
    taglineKey: "whatsNew.releases.1_32_0.tagline",
    highlights: [
      {
        icon: BookOpen,
        titleKey: "whatsNew.releases.1_32_0.items.documentationViewer.title",
        bodyKey: "whatsNew.releases.1_32_0.items.documentationViewer.body",
      },
      {
        icon: Gauge,
        titleKey: "whatsNew.releases.1_32_0.items.connectionCounts.title",
        bodyKey: "whatsNew.releases.1_32_0.items.connectionCounts.body",
      },
      {
        icon: RefreshCw,
        titleKey: "whatsNew.releases.1_32_0.items.tunnelsReconnect.title",
        bodyKey: "whatsNew.releases.1_32_0.items.tunnelsReconnect.body",
      },
      {
        icon: Power,
        titleKey: "whatsNew.releases.1_32_0.items.disconnectAndClose.title",
        bodyKey: "whatsNew.releases.1_32_0.items.disconnectAndClose.body",
      },
      {
        icon: Plug,
        titleKey: "whatsNew.releases.1_32_0.items.mcpFallback.title",
        bodyKey: "whatsNew.releases.1_32_0.items.mcpFallback.body",
      },
      {
        icon: ListTree,
        titleKey: "whatsNew.releases.1_32_0.items.schemaTree.title",
        bodyKey: "whatsNew.releases.1_32_0.items.schemaTree.body",
      },
    ],
  },
  {
    version: "1.31.0",
    major: true,
    taglineKey: "whatsNew.releases.1_31_0.tagline",
    highlights: [
      {
        icon: AppWindow,
        titleKey: "whatsNew.releases.1_31_0.items.environmentNewWindow.title",
        bodyKey: "whatsNew.releases.1_31_0.items.environmentNewWindow.body",
      },
      {
        icon: Trash2,
        titleKey: "whatsNew.releases.1_31_0.items.deleteRowReason.title",
        bodyKey: "whatsNew.releases.1_31_0.items.deleteRowReason.body",
      },
      {
        icon: ListChecks,
        titleKey: "whatsNew.releases.1_31_0.items.mongoLinePerStatement.title",
        bodyKey: "whatsNew.releases.1_31_0.items.mongoLinePerStatement.body",
      },
      {
        icon: ShieldAlert,
        titleKey: "whatsNew.releases.1_31_0.items.mongoTrailingRefused.title",
        bodyKey: "whatsNew.releases.1_31_0.items.mongoTrailingRefused.body",
      },
    ],
  },
  {
    version: "1.30.0",
    major: true,
    taglineKey: "whatsNew.releases.1_30_0.tagline",
    highlights: [
      {
        icon: RefreshCw,
        titleKey: "whatsNew.releases.1_30_0.items.silentUpdates.title",
        bodyKey: "whatsNew.releases.1_30_0.items.silentUpdates.body",
      },
      {
        icon: Plug,
        titleKey: "whatsNew.releases.1_30_0.items.extensionUpdates.title",
        bodyKey: "whatsNew.releases.1_30_0.items.extensionUpdates.body",
      },
      {
        icon: PanelTop,
        titleKey: "whatsNew.releases.1_30_0.items.unifiedTitleBar.title",
        bodyKey: "whatsNew.releases.1_30_0.items.unifiedTitleBar.body",
      },
      {
        icon: LayoutList,
        titleKey: "whatsNew.releases.1_30_0.items.jumpList.title",
        bodyKey: "whatsNew.releases.1_30_0.items.jumpList.body",
      },
    ],
  },
  {
    version: "1.29.0",
    major: true,
    taglineKey: "whatsNew.releases.1_29_0.tagline",
    highlights: [
      {
        icon: Building2,
        titleKey: "whatsNew.releases.1_29_0.items.managedPolicy.title",
        bodyKey: "whatsNew.releases.1_29_0.items.managedPolicy.body",
      },
      {
        icon: KeyRound,
        titleKey: "whatsNew.releases.1_29_0.items.personalDbUser.title",
        bodyKey: "whatsNew.releases.1_29_0.items.personalDbUser.body",
      },
      {
        icon: FilePen,
        titleKey: "whatsNew.releases.1_29_0.items.policyEditor.title",
        bodyKey: "whatsNew.releases.1_29_0.items.policyEditor.body",
      },
      {
        icon: ShieldCheck,
        titleKey: "whatsNew.releases.1_29_0.items.readOnlyEnforced.title",
        bodyKey: "whatsNew.releases.1_29_0.items.readOnlyEnforced.body",
      },
      {
        icon: Settings2,
        titleKey: "whatsNew.releases.1_29_0.items.preferences.title",
        bodyKey: "whatsNew.releases.1_29_0.items.preferences.body",
      },
      {
        icon: Search,
        titleKey: "whatsNew.releases.1_29_0.items.findEverywhere.title",
        bodyKey: "whatsNew.releases.1_29_0.items.findEverywhere.body",
      },
      {
        icon: Database,
        titleKey: "whatsNew.releases.1_29_0.items.mongoInsertTypes.title",
        bodyKey: "whatsNew.releases.1_29_0.items.mongoInsertTypes.body",
      },
    ],
  },
  {
    version: "1.28.0",
    major: true,
    taglineKey: "whatsNew.releases.1_28_0.tagline",
    highlights: [
      {
        icon: ListFilter,
        titleKey: "whatsNew.releases.1_28_0.items.queryPanel.title",
        bodyKey: "whatsNew.releases.1_28_0.items.queryPanel.body",
      },
      {
        icon: Braces,
        titleKey: "whatsNew.releases.1_28_0.items.handWrittenFilter.title",
        bodyKey: "whatsNew.releases.1_28_0.items.handWrittenFilter.body",
      },
      {
        icon: Columns3,
        titleKey: "whatsNew.releases.1_28_0.items.projection.title",
        bodyKey: "whatsNew.releases.1_28_0.items.projection.body",
      },
      {
        icon: ArrowUpDown,
        titleKey: "whatsNew.releases.1_28_0.items.sortEverywhere.title",
        bodyKey: "whatsNew.releases.1_28_0.items.sortEverywhere.body",
      },
      {
        icon: Gauge,
        titleKey: "whatsNew.releases.1_28_0.items.explainAndHints.title",
        bodyKey: "whatsNew.releases.1_28_0.items.explainAndHints.body",
      },
      {
        icon: RefreshCw,
        titleKey: "whatsNew.releases.1_28_0.items.fkPickerRefresh.title",
        bodyKey: "whatsNew.releases.1_28_0.items.fkPickerRefresh.body",
      },
    ],
  },
  {
    version: "1.27.0",
    major: true,
    taglineKey: "whatsNew.releases.1_27_0.tagline",
    highlights: [
      {
        icon: SquareTerminal,
        titleKey: "whatsNew.releases.1_27_0.items.createStatement.title",
        bodyKey: "whatsNew.releases.1_27_0.items.createStatement.body",
      },
      {
        icon: ShieldCheck,
        titleKey: "whatsNew.releases.1_27_0.items.dropTableReferences.title",
        bodyKey: "whatsNew.releases.1_27_0.items.dropTableReferences.body",
      },
      {
        icon: Timer,
        titleKey: "whatsNew.releases.1_27_0.items.operationTimeout.title",
        bodyKey: "whatsNew.releases.1_27_0.items.operationTimeout.body",
      },
      {
        icon: ListFilter,
        titleKey: "whatsNew.releases.1_27_0.items.mongoFilterTypes.title",
        bodyKey: "whatsNew.releases.1_27_0.items.mongoFilterTypes.body",
      },
    ],
  },
  {
    version: "1.26.0",
    major: true,
    taglineKey: "whatsNew.releases.1_26_0.tagline",
    highlights: [
      {
        icon: Package,
        titleKey: "whatsNew.releases.1_26_0.items.openVsxBrowser.title",
        bodyKey: "whatsNew.releases.1_26_0.items.openVsxBrowser.body",
      },
      {
        icon: Palette,
        titleKey: "whatsNew.releases.1_26_0.items.vscodeThemeImport.title",
        bodyKey: "whatsNew.releases.1_26_0.items.vscodeThemeImport.body",
      },
    ],
  },
  {
    version: "1.25.0",
    major: true,
    taglineKey: "whatsNew.releases.1_25_0.tagline",
    highlights: [
      {
        icon: Wand2,
        titleKey: "whatsNew.releases.1_25_0.items.autoFormat.title",
        bodyKey: "whatsNew.releases.1_25_0.items.autoFormat.body",
      },
      {
        icon: ListTree,
        titleKey: "whatsNew.releases.1_25_0.items.expandAll.title",
        bodyKey: "whatsNew.releases.1_25_0.items.expandAll.body",
      },
      {
        icon: Braces,
        titleKey: "whatsNew.releases.1_25_0.items.pasteRowsJson.title",
        bodyKey: "whatsNew.releases.1_25_0.items.pasteRowsJson.body",
      },
      {
        icon: Table2,
        titleKey: "whatsNew.releases.1_25_0.items.queryThisTable.title",
        bodyKey: "whatsNew.releases.1_25_0.items.queryThisTable.body",
      },
      {
        icon: Target,
        titleKey: "whatsNew.releases.1_25_0.items.focusFollowsTab.title",
        bodyKey: "whatsNew.releases.1_25_0.items.focusFollowsTab.body",
      },
      {
        icon: Timer,
        titleKey: "whatsNew.releases.1_25_0.items.fasterEnvironmentSwitch.title",
        bodyKey: "whatsNew.releases.1_25_0.items.fasterEnvironmentSwitch.body",
      },
      {
        icon: Copy,
        titleKey: "whatsNew.releases.1_25_0.items.mysqlBackslash.title",
        bodyKey: "whatsNew.releases.1_25_0.items.mysqlBackslash.body",
      },
    ],
  },
  {
    version: "1.24.0",
    major: true,
    taglineKey: "whatsNew.releases.1_24_0.tagline",
    highlights: [
      {
        icon: Share2,
        titleKey: "whatsNew.releases.1_24_0.items.originScope.title",
        bodyKey: "whatsNew.releases.1_24_0.items.originScope.body",
      },
      {
        icon: Database,
        titleKey: "whatsNew.releases.1_24_0.items.mongoDatabases.title",
        bodyKey: "whatsNew.releases.1_24_0.items.mongoDatabases.body",
      },
      {
        icon: FolderTree,
        titleKey: "whatsNew.releases.1_24_0.items.databaseNode.title",
        bodyKey: "whatsNew.releases.1_24_0.items.databaseNode.body",
      },
      {
        icon: ShieldCheck,
        titleKey: "whatsNew.releases.1_24_0.items.dropGuard.title",
        bodyKey: "whatsNew.releases.1_24_0.items.dropGuard.body",
      },
      {
        icon: ListTree,
        titleKey: "whatsNew.releases.1_24_0.items.emptyServer.title",
        bodyKey: "whatsNew.releases.1_24_0.items.emptyServer.body",
      },
    ],
  },
  {
    version: "1.23.0",
    major: true,
    taglineKey: "whatsNew.releases.1_23_0.tagline",
    highlights: [
      {
        icon: LayoutList,
        titleKey: "whatsNew.releases.1_23_0.items.multiResults.title",
        bodyKey: "whatsNew.releases.1_23_0.items.multiResults.body",
      },
      {
        icon: SquareTerminal,
        titleKey: "whatsNew.releases.1_23_0.items.mongoEditor.title",
        bodyKey: "whatsNew.releases.1_23_0.items.mongoEditor.body",
      },
      {
        icon: ShieldCheck,
        titleKey: "whatsNew.releases.1_23_0.items.mongoComments.title",
        bodyKey: "whatsNew.releases.1_23_0.items.mongoComments.body",
      },
      {
        icon: Layers,
        titleKey: "whatsNew.releases.1_23_0.items.dialogTiers.title",
        bodyKey: "whatsNew.releases.1_23_0.items.dialogTiers.body",
      },
      {
        icon: Palette,
        titleKey: "whatsNew.releases.1_23_0.items.inAppConfirm.title",
        bodyKey: "whatsNew.releases.1_23_0.items.inAppConfirm.body",
      },
      {
        icon: Table2,
        titleKey: "whatsNew.releases.1_23_0.items.gridClipping.title",
        bodyKey: "whatsNew.releases.1_23_0.items.gridClipping.body",
      },
    ],
  },
  {
    version: "1.22.0",
    major: true,
    taglineKey: "whatsNew.releases.1_22_0.tagline",
    highlights: [
      {
        icon: Bot,
        titleKey: "whatsNew.releases.1_22_0.items.aiPanel.title",
        bodyKey: "whatsNew.releases.1_22_0.items.aiPanel.body",
      },
      {
        icon: ShieldCheck,
        titleKey: "whatsNew.releases.1_22_0.items.aiTwoSwitches.title",
        bodyKey: "whatsNew.releases.1_22_0.items.aiTwoSwitches.body",
      },
      {
        icon: Wand2,
        titleKey: "whatsNew.releases.1_22_0.items.aiAssisted.title",
        bodyKey: "whatsNew.releases.1_22_0.items.aiAssisted.body",
      },
      {
        icon: SquareTerminal,
        titleKey: "whatsNew.releases.1_22_0.items.aiAgent.title",
        bodyKey: "whatsNew.releases.1_22_0.items.aiAgent.body",
      },
      {
        icon: ListFilter,
        titleKey: "whatsNew.releases.1_22_0.items.mongoNestedFilter.title",
        bodyKey: "whatsNew.releases.1_22_0.items.mongoNestedFilter.body",
      },
      {
        icon: Share2,
        titleKey: "whatsNew.releases.1_22_0.items.originCredentials.title",
        bodyKey: "whatsNew.releases.1_22_0.items.originCredentials.body",
      },
    ],
  },
  {
    version: "1.21.0",
    major: true,
    taglineKey: "whatsNew.releases.1_21_0.tagline",
    highlights: [
      {
        icon: Bot,
        titleKey: "whatsNew.releases.1_21_0.items.mcpConnections.title",
        bodyKey: "whatsNew.releases.1_21_0.items.mcpConnections.body",
      },
      {
        icon: Plug,
        titleKey: "whatsNew.releases.1_21_0.items.mcpSetup.title",
        bodyKey: "whatsNew.releases.1_21_0.items.mcpSetup.body",
      },
      {
        icon: Layers,
        titleKey: "whatsNew.releases.1_21_0.items.aggregationStages.title",
        bodyKey: "whatsNew.releases.1_21_0.items.aggregationStages.body",
      },
      {
        icon: Table2,
        titleKey: "whatsNew.releases.1_21_0.items.gridWrites.title",
        bodyKey: "whatsNew.releases.1_21_0.items.gridWrites.body",
      },
      {
        icon: Gauge,
        titleKey: "whatsNew.releases.1_21_0.items.mongoReliability.title",
        bodyKey: "whatsNew.releases.1_21_0.items.mongoReliability.body",
      },
      {
        icon: Palette,
        titleKey: "whatsNew.releases.1_21_0.items.designRefresh.title",
        bodyKey: "whatsNew.releases.1_21_0.items.designRefresh.body",
      },
    ],
  },
  {
    version: "1.20.0",
    major: true,
    taglineKey: "whatsNew.releases.1_20_0.tagline",
    highlights: [
      {
        icon: Activity,
        titleKey: "whatsNew.releases.1_20_0.items.pulse.title",
        bodyKey: "whatsNew.releases.1_20_0.items.pulse.body",
      },
      {
        icon: Share2,
        titleKey: "whatsNew.releases.1_20_0.items.originEditing.title",
        bodyKey: "whatsNew.releases.1_20_0.items.originEditing.body",
      },
      {
        icon: Layers,
        titleKey: "whatsNew.releases.1_20_0.items.aggregationAutocomplete.title",
        bodyKey: "whatsNew.releases.1_20_0.items.aggregationAutocomplete.body",
      },
      {
        icon: Gauge,
        titleKey: "whatsNew.releases.1_20_0.items.performance.title",
        bodyKey: "whatsNew.releases.1_20_0.items.performance.body",
      },
      {
        icon: SquareTerminal,
        titleKey: "whatsNew.releases.1_20_0.items.cliEnvironments.title",
        bodyKey: "whatsNew.releases.1_20_0.items.cliEnvironments.body",
      },
    ],
  },
  {
    version: "1.19.0",
    major: true,
    taglineKey: "whatsNew.releases.1_19_0.tagline",
    highlights: [
      {
        icon: Share2,
        titleKey: "whatsNew.releases.1_19_0.items.sharedOriginEditor.title",
        bodyKey: "whatsNew.releases.1_19_0.items.sharedOriginEditor.body",
      },
      {
        icon: Keyboard,
        titleKey: "whatsNew.releases.1_19_0.items.keyboardShortcuts.title",
        bodyKey: "whatsNew.releases.1_19_0.items.keyboardShortcuts.body",
      },
      {
        icon: Database,
        titleKey: "whatsNew.releases.1_19_0.items.mongoIndexDdl.title",
        bodyKey: "whatsNew.releases.1_19_0.items.mongoIndexDdl.body",
      },
      {
        icon: Table2,
        titleKey: "whatsNew.releases.1_19_0.items.pinnedColumns.title",
        bodyKey: "whatsNew.releases.1_19_0.items.pinnedColumns.body",
      },
      {
        icon: ListFilter,
        titleKey: "whatsNew.releases.1_19_0.items.schemaSearch.title",
        bodyKey: "whatsNew.releases.1_19_0.items.schemaSearch.body",
      },
      {
        icon: FolderTree,
        titleKey: "whatsNew.releases.1_19_0.items.connectionProvenance.title",
        bodyKey: "whatsNew.releases.1_19_0.items.connectionProvenance.body",
      },
    ],
  },
  {
    version: "1.18.0",
    major: true,
    taglineKey: "whatsNew.releases.1_18_0.tagline",
    highlights: [
      {
        icon: Bell,
        titleKey: "whatsNew.releases.1_18_0.items.notifications.title",
        bodyKey: "whatsNew.releases.1_18_0.items.notifications.body",
      },
      {
        icon: Eye,
        titleKey: "whatsNew.releases.1_18_0.items.mcpViews.title",
        bodyKey: "whatsNew.releases.1_18_0.items.mcpViews.body",
      },
      {
        icon: Gauge,
        titleKey: "whatsNew.releases.1_18_0.items.performance.title",
        bodyKey: "whatsNew.releases.1_18_0.items.performance.body",
      },
      {
        icon: Bug,
        titleKey: "whatsNew.releases.1_18_0.items.bugFixes.title",
        bodyKey: "whatsNew.releases.1_18_0.items.bugFixes.body",
      },
      {
        icon: BookOpen,
        titleKey: "whatsNew.releases.1_18_0.items.docsSections.title",
        bodyKey: "whatsNew.releases.1_18_0.items.docsSections.body",
      },
    ],
  },
  {
    version: "1.17.0",
    major: true,
    taglineKey: "whatsNew.releases.1_17_0.tagline",
    highlights: [
      {
        icon: Braces,
        titleKey: "whatsNew.releases.1_17_0.items.jsonSchemas.title",
        bodyKey: "whatsNew.releases.1_17_0.items.jsonSchemas.body",
      },
      {
        icon: Gauge,
        titleKey: "whatsNew.releases.1_17_0.items.querySafety.title",
        bodyKey: "whatsNew.releases.1_17_0.items.querySafety.body",
      },
      {
        icon: Share2,
        titleKey: "whatsNew.releases.1_17_0.items.originEnvironments.title",
        bodyKey: "whatsNew.releases.1_17_0.items.originEnvironments.body",
      },
      {
        icon: Download,
        titleKey: "whatsNew.releases.1_17_0.items.importProgress.title",
        bodyKey: "whatsNew.releases.1_17_0.items.importProgress.body",
      },
      {
        icon: Table2,
        titleKey: "whatsNew.releases.1_17_0.items.columnReorder.title",
        bodyKey: "whatsNew.releases.1_17_0.items.columnReorder.body",
      },
    ],
  },
  {
    version: "1.16.0",
    major: true,
    taglineKey: "whatsNew.releases.1_16_0.tagline",
    highlights: [
      {
        icon: Layers,
        titleKey: "whatsNew.releases.1_16_0.items.mongoAggregation.title",
        bodyKey: "whatsNew.releases.1_16_0.items.mongoAggregation.body",
      },
      {
        icon: ListTree,
        titleKey: "whatsNew.releases.1_16_0.items.mongoIndexes.title",
        bodyKey: "whatsNew.releases.1_16_0.items.mongoIndexes.body",
      },
      {
        icon: Plug,
        titleKey: "whatsNew.releases.1_16_0.items.connectionReliability.title",
        bodyKey: "whatsNew.releases.1_16_0.items.connectionReliability.body",
      },
      {
        icon: ImagePlus,
        titleKey: "whatsNew.releases.1_16_0.items.brandIdentity.title",
        bodyKey: "whatsNew.releases.1_16_0.items.brandIdentity.body",
      },
      {
        icon: Palette,
        titleKey: "whatsNew.releases.1_16_0.items.themePairs.title",
        bodyKey: "whatsNew.releases.1_16_0.items.themePairs.body",
      },
    ],
  },
  {
    version: "1.15.0",
    major: true,
    taglineKey: "whatsNew.releases.1_15_0.tagline",
    highlights: [
      {
        icon: ImagePlus,
        titleKey: "whatsNew.releases.1_15_0.items.environmentAvatars.title",
        bodyKey: "whatsNew.releases.1_15_0.items.environmentAvatars.body",
      },
      {
        icon: Download,
        titleKey: "whatsNew.releases.1_15_0.items.linuxBuilds.title",
        bodyKey: "whatsNew.releases.1_15_0.items.linuxBuilds.body",
      },
      {
        icon: FolderTree,
        titleKey: "whatsNew.releases.1_15_0.items.independentFolds.title",
        bodyKey: "whatsNew.releases.1_15_0.items.independentFolds.body",
      },
      {
        icon: Power,
        titleKey: "whatsNew.releases.1_15_0.items.restartFeedback.title",
        bodyKey: "whatsNew.releases.1_15_0.items.restartFeedback.body",
      },
    ],
  },
  {
    version: "1.14.0",
    major: true,
    taglineKey: "whatsNew.releases.1_14_0.tagline",
    highlights: [
      {
        icon: SquareTerminal,
        titleKey: "whatsNew.releases.1_14_0.items.paletteLauncher.title",
        bodyKey: "whatsNew.releases.1_14_0.items.paletteLauncher.body",
      },
      {
        icon: PanelTop,
        titleKey: "whatsNew.releases.1_14_0.items.activityBarShell.title",
        bodyKey: "whatsNew.releases.1_14_0.items.activityBarShell.body",
      },
      {
        icon: Layers,
        titleKey: "whatsNew.releases.1_14_0.items.environmentRail.title",
        bodyKey: "whatsNew.releases.1_14_0.items.environmentRail.body",
      },
      {
        icon: Palette,
        titleKey: "whatsNew.releases.1_14_0.items.themeTransfer.title",
        bodyKey: "whatsNew.releases.1_14_0.items.themeTransfer.body",
      },
      {
        icon: Table2,
        titleKey: "whatsNew.releases.1_14_0.items.columnFit.title",
        bodyKey: "whatsNew.releases.1_14_0.items.columnFit.body",
      },
    ],
  },
  {
    version: "1.13.0",
    major: true,
    taglineKey: "whatsNew.releases.1_13_0.tagline",
    highlights: [
      {
        icon: Server,
        titleKey: "whatsNew.releases.1_13_0.items.sqlServer.title",
        bodyKey: "whatsNew.releases.1_13_0.items.sqlServer.body",
      },
      {
        icon: Gauge,
        titleKey: "whatsNew.releases.1_13_0.items.connectionFootprint.title",
        bodyKey: "whatsNew.releases.1_13_0.items.connectionFootprint.body",
      },
      {
        icon: SlidersHorizontal,
        titleKey: "whatsNew.releases.1_13_0.items.connectionSettings.title",
        bodyKey: "whatsNew.releases.1_13_0.items.connectionSettings.body",
      },
      {
        icon: LayoutList,
        titleKey: "whatsNew.releases.1_13_0.items.listEditor.title",
        bodyKey: "whatsNew.releases.1_13_0.items.listEditor.body",
      },
      {
        icon: Bot,
        titleKey: "whatsNew.releases.1_13_0.items.mcpPools.title",
        bodyKey: "whatsNew.releases.1_13_0.items.mcpPools.body",
      },
    ],
  },
  {
    version: "1.12.1",
    major: true,
    taglineKey: "whatsNew.releases.1_12_1.tagline",
    highlights: [
      {
        icon: Database,
        titleKey: "whatsNew.releases.1_12_1.items.exportImport.title",
        bodyKey: "whatsNew.releases.1_12_1.items.exportImport.body",
      },
      {
        icon: Copy,
        titleKey: "whatsNew.releases.1_12_1.items.bulkUpdate.title",
        bodyKey: "whatsNew.releases.1_12_1.items.bulkUpdate.body",
      },
      {
        icon: Tags,
        titleKey: "whatsNew.releases.1_12_1.items.structureEditor.title",
        bodyKey: "whatsNew.releases.1_12_1.items.structureEditor.body",
      },
      {
        icon: Pencil,
        titleKey: "whatsNew.releases.1_12_1.items.tableRename.title",
        bodyKey: "whatsNew.releases.1_12_1.items.tableRename.body",
      },
    ],
  },
  {
    version: "1.12.0",
    major: true,
    taglineKey: "whatsNew.releases.1_12_0.tagline",
    highlights: [
      {
        icon: Layers,
        titleKey: "whatsNew.releases.1_12_0.items.environments.title",
        bodyKey: "whatsNew.releases.1_12_0.items.environments.body",
      },
      {
        icon: Share2,
        titleKey: "whatsNew.releases.1_12_0.items.sharedOrigins.title",
        bodyKey: "whatsNew.releases.1_12_0.items.sharedOrigins.body",
      },
      {
        icon: FolderTree,
        titleKey: "whatsNew.releases.1_12_0.items.connectionsInTree.title",
        bodyKey: "whatsNew.releases.1_12_0.items.connectionsInTree.body",
      },
      {
        icon: ListFilter,
        titleKey: "whatsNew.releases.1_12_0.items.filterSelected.title",
        bodyKey: "whatsNew.releases.1_12_0.items.filterSelected.body",
      },
      {
        icon: Timer,
        titleKey: "whatsNew.releases.1_12_0.items.queryFeedback.title",
        bodyKey: "whatsNew.releases.1_12_0.items.queryFeedback.body",
      },
      {
        icon: Palette,
        titleKey: "whatsNew.releases.1_12_0.items.neonTheme.title",
        bodyKey: "whatsNew.releases.1_12_0.items.neonTheme.body",
      },
    ],
  },
  {
    version: "1.11.0",
    major: true,
    taglineKey: "whatsNew.releases.1_11_0.tagline",
    highlights: [
      {
        icon: Power,
        titleKey: "whatsNew.releases.1_11_0.items.reconnect.title",
        bodyKey: "whatsNew.releases.1_11_0.items.reconnect.body",
      },
      {
        icon: Gauge,
        titleKey: "whatsNew.releases.1_11_0.items.fastOpen.title",
        bodyKey: "whatsNew.releases.1_11_0.items.fastOpen.body",
      },
      {
        icon: PanelTop,
        titleKey: "whatsNew.releases.1_11_0.items.toolbar.title",
        bodyKey: "whatsNew.releases.1_11_0.items.toolbar.body",
      },
      {
        icon: LayoutList,
        titleKey: "whatsNew.releases.1_11_0.items.mongoList.title",
        bodyKey: "whatsNew.releases.1_11_0.items.mongoList.body",
      },
      {
        icon: ExternalLink,
        titleKey: "whatsNew.releases.1_11_0.items.floatWindow.title",
        bodyKey: "whatsNew.releases.1_11_0.items.floatWindow.body",
      },
    ],
  },
  {
    version: "1.10.0",
    major: true,
    taglineKey: "whatsNew.releases.1_10_0.tagline",
    highlights: [
      {
        icon: Eye,
        titleKey: "whatsNew.releases.1_10_0.items.viewsEditor.title",
        bodyKey: "whatsNew.releases.1_10_0.items.viewsEditor.body",
      },
      {
        icon: ListFilter,
        titleKey: "whatsNew.releases.1_10_0.items.betweenFilter.title",
        bodyKey: "whatsNew.releases.1_10_0.items.betweenFilter.body",
      },
      {
        icon: Keyboard,
        titleKey: "whatsNew.releases.1_10_0.items.shortcuts.title",
        bodyKey: "whatsNew.releases.1_10_0.items.shortcuts.body",
      },
      {
        icon: Copy,
        titleKey: "whatsNew.releases.1_10_0.items.gridQuickActions.title",
        bodyKey: "whatsNew.releases.1_10_0.items.gridQuickActions.body",
      },
    ],
  },
  {
    version: "1.9.0",
    major: true,
    taglineKey: "whatsNew.releases.1_9_0.tagline",
    highlights: [
      {
        icon: Pencil,
        titleKey: "whatsNew.releases.1_9_0.items.mcpWrite.title",
        bodyKey: "whatsNew.releases.1_9_0.items.mcpWrite.body",
      },
      {
        icon: ShieldCheck,
        titleKey: "whatsNew.releases.1_9_0.items.mcpPolicy.title",
        bodyKey: "whatsNew.releases.1_9_0.items.mcpPolicy.body",
      },
      {
        icon: ListFilter,
        titleKey: "whatsNew.releases.1_9_0.items.advancedFilter.title",
        bodyKey: "whatsNew.releases.1_9_0.items.advancedFilter.body",
      },
    ],
  },
  {
    version: "1.8.0",
    major: true,
    taglineKey: "whatsNew.releases.1_8_0.tagline",
    highlights: [
      {
        icon: ShieldCheck,
        titleKey: "whatsNew.releases.1_8_0.items.security.title",
        bodyKey: "whatsNew.releases.1_8_0.items.security.body",
      },
      {
        icon: Bot,
        titleKey: "whatsNew.releases.1_8_0.items.mcpMongo.title",
        bodyKey: "whatsNew.releases.1_8_0.items.mcpMongo.body",
      },
      {
        icon: Target,
        titleKey: "whatsNew.releases.1_8_0.items.mcpMongoDatabase.title",
        bodyKey: "whatsNew.releases.1_8_0.items.mcpMongoDatabase.body",
      },
      {
        icon: Tags,
        titleKey: "whatsNew.releases.1_8_0.items.columnTypes.title",
        bodyKey: "whatsNew.releases.1_8_0.items.columnTypes.body",
      },
      {
        icon: HardDrive,
        titleKey: "whatsNew.releases.1_8_0.items.collectionSize.title",
        bodyKey: "whatsNew.releases.1_8_0.items.collectionSize.body",
      },
    ],
  },
  {
    version: "1.7.0",
    major: true,
    taglineKey: "whatsNew.releases.1_7_0.tagline",
    highlights: [
      {
        icon: Bot,
        titleKey: "whatsNew.releases.1_7_0.items.connector.title",
        bodyKey: "whatsNew.releases.1_7_0.items.connector.body",
      },
      {
        icon: ShieldCheck,
        titleKey: "whatsNew.releases.1_7_0.items.safety.title",
        bodyKey: "whatsNew.releases.1_7_0.items.safety.body",
      },
    ],
  },
  {
    version: "1.6.0",
    major: true,
    taglineKey: "whatsNew.releases.1_6_0.tagline",
    highlights: [
      {
        icon: Palette,
        titleKey: "whatsNew.releases.1_6_0.items.design.title",
        bodyKey: "whatsNew.releases.1_6_0.items.design.body",
      },
      {
        icon: Table2,
        titleKey: "whatsNew.releases.1_6_0.items.grid.title",
        bodyKey: "whatsNew.releases.1_6_0.items.grid.body",
      },
      {
        icon: ListTree,
        titleKey: "whatsNew.releases.1_6_0.items.schema.title",
        bodyKey: "whatsNew.releases.1_6_0.items.schema.body",
      },
      {
        icon: SquareTerminal,
        titleKey: "whatsNew.releases.1_6_0.items.editor.title",
        bodyKey: "whatsNew.releases.1_6_0.items.editor.body",
      },
      {
        icon: Plug,
        titleKey: "whatsNew.releases.1_6_0.items.chrome.title",
        bodyKey: "whatsNew.releases.1_6_0.items.chrome.body",
      },
    ],
  },
];

/** The release note for a specific version, if one exists. */
export function getReleaseNote(version: string): ReleaseNote | null {
  return RELEASE_NOTES.find((r) => r.version === version) ?? null;
}

/** The most recent release note in the catalogue (for the manual entry). */
export function latestReleaseNote(): ReleaseNote | null {
  return RELEASE_NOTES[0] ?? null;
}
