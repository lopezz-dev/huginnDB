/**
 * The app's one confirm dialog, replacing `window.confirm` — see
 * `lib/confirmDestructive.ts` and `stores/dialogs/confirmRequest.ts`.
 *
 * Mounted once per window (`App.tsx`, `shell/DetachedTabWindow.tsx` —
 * required, since `TableDataTab`/`DocumentListView` call `confirmDestructive`
 * from there too — and `pulse/PulseWindow.tsx`), the same way `ConfirmDialog`
 * itself is used, not shared as a singleton across windows: each renders its
 * own against the one `useConfirmRequest` store that exists per window.
 *
 * Deliberately has no `submitting` state of its own. `window.confirm` was
 * synchronous and blocked the caller until it returned; a Promise does not,
 * so the temptation is to `await` inside here and disable the buttons while
 * that runs. Don't — the caller does its own work *after* this resolves
 * (see the ten call sites this replaces), which is exactly the shape
 * `useAsyncSubmit`'s deliberate "stay busy after success" (ADR #44)
 * depends on; a host that manages its own busy state would race it instead.
 */

import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogActions } from "@/components/ui/dialog-actions";
import { useConfirmRequest } from "@/stores/dialogs/confirmRequest";

export function ConfirmHost() {
  const { t } = useTranslation();
  const current = useConfirmRequest((s) => s.current);
  const resolve = useConfirmRequest((s) => s.resolve);

  return (
    <Dialog open={!!current} onOpenChange={(open) => !open && resolve(false)}>
      {current && (
        <DialogContent tier="prompt">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {t("common.confirmTitle")}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogDescription className="text-xs">
              {current.message}
            </DialogDescription>
          </DialogBody>
          <DialogActions
            onCancel={() => resolve(false)}
            cancelLabel={t("common.cancel")}
            confirmLabel={t("common.confirm")}
            onConfirm={() => resolve(true)}
            confirmVariant="destructive"
          />
        </DialogContent>
      )}
    </Dialog>
  );
}
