/**
 * Dialog for exporting one or more environments — each one's cosmetics and
 * registered shared origins, plus a single deduplicated pool of the
 * connection profiles any of them reference — to a single JSON file.
 *
 * Reachable from two places (see `stores/dialogs/environmentTransfer.ts`):
 * File → "Export environments…" (opens with every environment checked, like
 * `ExportProfilesDialog`'s profile picker) and a per-row shortcut in
 * `EnvironmentSwitcher` (opens pre-checking just that one row). Both funnel
 * into this same checklist so a user who started from one row can still
 * widen the selection before exporting.
 *
 * Tabs, layout and launch state are never included — see the module doc in
 * `src-tauri/src/transfer.rs` for why.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { notify } from "@/lib/notify";
import { api } from "@/lib/tauri";
import {
  useEnvironments,
  environmentLabel,
} from "@/stores/session/environments";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useMultiSelect } from "@/lib/useMultiSelect";
import {
  PassphraseFields,
  passphraseAccepted,
} from "@/components/common/PassphraseFields";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  /** Environment ids to pre-check when the dialog opens. `null`/omitted
   *  pre-checks every environment. */
  preselect: string[] | null;
  onClose: () => void;
}

export function ExportEnvironmentDialog({ open, preselect, onClose }: Props) {
  const { t } = useTranslation();
  const environments = useEnvironments((s) => s.environments);
  const allIds = useMemo(() => environments.map((e) => e.id), [environments]);
  // The trigger decides the initial checklist: the per-row shortcut in
  // `EnvironmentSwitcher` pre-checks just that one, the File-menu entry checks
  // everything.
  const seed = useMemo(
    () => (preselect && preselect.length > 0 ? preselect : undefined),
    [preselect],
  );
  const { selected, allSelected, toggle, toggleAll, reseed } = useMultiSelect(
    allIds,
    seed,
  );
  const [includePasswords, setIncludePasswords] = useState(false);
  // Opt-in, and off by default: schemas are global rather than owned by an
  // environment, so bundling them is a convenience for setting up a machine, not
  // part of what makes an environment portable (ADR #35).
  const [includeJsonSchemas, setIncludeJsonSchemas] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirm, setPassphraseConfirm] = useState("");
  const [loading, setLoading] = useState(false);

  const defaultName = t("environments.defaultName");

  // Re-seed the checklist every time the dialog opens. Deliberately *not* on
  // every `environments` change — a live switcher update mid-dialog must not
  // reset the user's picks.
  useEffect(() => {
    if (open) reseed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seed]);

  const canExport =
    selected.size > 0 &&
    (!includePasswords || passphraseAccepted(passphrase, passphraseConfirm));

  async function handleExport() {
    if (!canExport) return;
    setLoading(true);
    try {
      const path = await api.exportEnvironments(
        Array.from(selected),
        includePasswords,
        includePasswords ? passphrase : undefined,
        includeJsonSchemas,
      );
      notify.file(t("notifications.fileSaved.environments"), { path });
      handleOpenChange(false);
    } catch (e) {
      notify.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  function handleOpenChange(v: boolean) {
    if (!v) {
      setIncludePasswords(false);
      setIncludeJsonSchemas(false);
      setPassphrase("");
      setPassphraseConfirm("");
      onClose();
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent tier="panel">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Download className="h-4 w-4" />
            {t("transfer.exportEnvironment.title")}
          </DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <p className="text-xs text-muted-foreground">
            {t("transfer.exportEnvironment.description")}
          </p>

          {/* Environment selection list */}
          <div className="space-y-1">
            <div className="flex items-center justify-between pb-1">
              <Label className="text-xs text-muted-foreground">
                {t("transfer.exportEnvironment.environments")}
              </Label>
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto p-0"
                onClick={toggleAll}
              >
                {allSelected
                  ? t("transfer.export.deselectAll")
                  : t("transfer.export.selectAll")}
              </Button>
            </div>
            <div className="rounded-md border border-border divide-y divide-border max-h-48 overflow-y-auto">
              {environments.map((env) => (
                <label
                  key={env.id}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/50"
                >
                  <Checkbox
                    checked={selected.has(env.id)}
                    onChange={() => toggle(env.id)}
                  />
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor: env.color || "var(--muted-foreground)",
                    }}
                  />
                  <span className="flex-1 truncate text-xs">
                    {environmentLabel(env, defaultName)}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Include passwords toggle */}
          <div className="flex items-center gap-3">
            <Switch
              id="export-env-include-passwords"
              checked={includePasswords}
              onCheckedChange={setIncludePasswords}
            />
            <Label
              htmlFor="export-env-include-passwords"
              className="cursor-pointer text-xs"
            >
              {t("transfer.export.includePasswords")}
            </Label>
          </div>

          {/* JSON Schemas ride along, but are not part of the environment. */}
          <div className="flex items-start gap-3">
            <Switch
              id="export-env-include-json-schemas"
              checked={includeJsonSchemas}
              onCheckedChange={setIncludeJsonSchemas}
            />
            <div className="min-w-0">
              <Label
                htmlFor="export-env-include-json-schemas"
                className="cursor-pointer text-xs"
              >
                {t("transfer.exportEnvironment.includeJsonSchemas")}
              </Label>
              <p className="text-2xs text-muted-foreground">
                {t("transfer.exportEnvironment.includeJsonSchemasHint")}
              </p>
            </div>
          </div>

          {includePasswords && (
            <PassphraseFields
              passphrase={passphrase}
              confirm={passphraseConfirm}
              onPassphraseChange={setPassphrase}
              onConfirmChange={setPassphraseConfirm}
              idPrefix="export-env"
            />
          )}
        </DialogBody>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleOpenChange(false)}
            disabled={loading}
          >
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={handleExport}
            disabled={!canExport || loading}
            icon={Download}
          >
            {loading
              ? t("transfer.export.exporting")
              : t("transfer.exportEnvironment.exportButton", {
                  count: selected.size,
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
