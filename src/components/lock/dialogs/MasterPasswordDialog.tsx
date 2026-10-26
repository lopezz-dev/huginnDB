/**
 * The three things done with the master password from Settings: set it (turn
 * the lock on), change it, and confirm it (turn the lock off). One dialog
 * because they are one form in three shapes, and the `prompt` anatomy
 * because each is a single question.
 *
 * Turning the lock on asks one more thing first, through `ConfirmHost`: that
 * the person understands a forgotten master password loses every secret in
 * the vault. That is the only recovery story there is (ADR #118), so it is
 * said before the secrets move, not after.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PasswordInput } from "@/components/common/PasswordInput";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogActions } from "@/components/ui/dialog-actions";
import { Label } from "@/components/ui/label";
import { confirmIrreversible } from "@/lib/confirmDestructive";
import { notify } from "@/lib/notify";
import { api } from "@/lib/tauri";
import { MasterPasswordFields } from "../MasterPasswordFields";

export type MasterPasswordMode = "enable" | "change" | "disable";

export function MasterPasswordDialog({
  mode,
  minChars,
  onClose,
}: {
  mode: MasterPasswordMode | null;
  minChars: number;
  onClose: () => void;
}) {
  return (
    <Dialog open={mode !== null} onOpenChange={(open) => !open && onClose()}>
      {mode && <Body key={mode} mode={mode} minChars={minChars} onClose={onClose} />}
    </Dialog>
  );
}

function Body({
  mode,
  minChars,
  onClose,
}: {
  mode: MasterPasswordMode;
  minChars: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsCurrent = mode !== "enable";
  const needsNext = mode !== "disable";
  const ready = (!needsCurrent || current.length > 0) && (!needsNext || next !== null);

  const submit = async () => {
    if (!ready) return;
    if (mode === "enable" && !(await confirmIrreversible(t("lock.enable.confirm")))) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "enable") {
        const moved = await api.vaultEnable(next!);
        notify.success(t("lock.enable.done", { count: moved }));
      } else if (mode === "change") {
        await api.vaultChangePassword(current, next!);
        notify.success(t("lock.change.done"));
      } else {
        const moved = await api.vaultDisable(current);
        notify.success(t("lock.disable.done", { count: moved }));
      }
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <DialogContent tier="prompt">
      <DialogHeader>
        <DialogTitle className="text-sm">{t(`lock.${mode}.title`)}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <DialogDescription className="text-xs leading-relaxed">
          {t(`lock.${mode}.desc`)}
        </DialogDescription>
        {needsCurrent && (
          <div className="space-y-1.5">
            <Label htmlFor="lock-current-password" className="text-xs">
              {t("lock.fields.current")}
            </Label>
            <PasswordInput
              id="lock-current-password"
              autoFocus
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && mode === "disable") void submit();
              }}
            />
          </div>
        )}
        {needsNext && (
          <MasterPasswordFields minChars={minChars} onChange={setNext} autoFocus={!needsCurrent} />
        )}
        {error && <p className="text-2xs text-destructive">{error}</p>}
      </DialogBody>
      <DialogActions
        onCancel={onClose}
        cancelLabel={t("common.cancel")}
        confirmLabel={t(`lock.${mode}.action`)}
        onConfirm={() => void submit()}
        confirming={busy}
        confirmDisabled={!ready}
        confirmVariant={mode === "disable" ? "destructive" : "default"}
      />
    </DialogContent>
  );
}
