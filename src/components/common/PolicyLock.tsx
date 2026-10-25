/**
 * The shapes a control locked by the managed policy takes outside a menu (a
 * menu item takes `ContextMenuAction`'s `locked` prop instead):
 *
 * - `PolicyLockHint` puts the reason on a disabled button's hover. A disabled
 *   `Button` has `pointer-events: none`, so the tooltip cannot hang on the
 *   button itself — it hangs on a focusable `<span>` around it, which also
 *   lets a keyboard user reach the reason.
 * - `PolicyLockedState` replaces a whole tab whose purpose the policy does not
 *   allow (a query editor without free SQL, Security without `monitor`), with
 *   the reason as its hint — rather than mounting the tab and letting every
 *   request it makes fail. `PolicyGate` is that swap, for the places a tab's
 *   body is mounted (`TabbedArea`, `DetachedTabWindow`) — which is also what
 *   covers a tab restored from a previous session, not only one opened now.
 *
 * - `PolicyVerbNotice` is the one line a grid shows when some of its row
 *   actions are missing because of the policy — a cell that does not open
 *   for editing says nothing on its own, so the reason is said once, above.
 *
 * They take the text `usePolicyLock` returns (or, for the notice, which verbs
 * are locked), and render the ordinary thing — the child, or nothing — when
 * nothing is.
 */

import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "i18next";
import { EmptyState } from "@/components/common/EmptyState";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { usePolicyLock, type PolicyNeed } from "@/lib/policy/access";

export function PolicyLockHint({
  reason,
  children,
}: {
  reason: string | null;
  children: ReactNode;
}) {
  if (!reason) return <>{children}</>;
  return (
    <SimpleTooltip label={reason}>
      <span tabIndex={0} className="inline-flex cursor-not-allowed">
        {children}
      </span>
    </SimpleTooltip>
  );
}

export function PolicyLockedState({
  reason,
  size,
}: {
  reason: string;
  size?: "sm" | "md";
}) {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={Lock}
      size={size}
      title={t("policy.lockedTitle")}
      hint={reason}
    />
  );
}

export function PolicyGate({
  connectionId,
  need,
  relation,
  children,
}: {
  connectionId: string;
  need: PolicyNeed;
  relation?: { schema: string | null | undefined; name: string } | null;
  children: ReactNode;
}) {
  const reason = usePolicyLock(connectionId, need, relation);
  if (reason) return <PolicyLockedState reason={reason} />;
  return <>{children}</>;
}

export function PolicyVerbNotice({
  locked,
  columns,
}: {
  locked: { insert: boolean; update: boolean; delete: boolean };
  /**
   * Which columns each verb may write, when the role limits them (ADR #113) —
   * `null` for a verb that is not limited (or not allowed at all, which
   * `locked` already says). A cell that does not open says nothing on its
   * own, so the notice names the columns that do.
   */
  columns?: { insert: string[] | null; update: string[] | null };
}) {
  const { t } = useTranslation();
  const list = new Intl.ListFormat(i18n.language, {
    style: "long",
    type: "conjunction",
  });
  const verbs = (["insert", "update", "delete"] as const).filter(
    (v) => locked[v],
  );
  const parts: string[] = [];
  if (verbs.length > 0) {
    const what = list.format(verbs.map((v) => t(`policy.rows.${v}`)));
    parts.push(t("policy.rows.notice", { what }));
  }
  for (const verb of ["update", "insert"] as const) {
    const allowed = columns?.[verb];
    if (!allowed) continue;
    parts.push(
      allowed.length === 0
        ? t(`policy.rows.noColumns.${verb}`)
        : t(`policy.rows.onlyColumns.${verb}`, { columns: list.format(allowed) }),
    );
  }
  if (parts.length === 0) return null;
  const text = parts.join(" · ");
  return (
    <div
      role="note"
      className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-3 py-1 text-2xs text-muted-foreground"
    >
      <Lock aria-hidden className="h-3 w-3 shrink-0" />
      <span className="truncate">{text}</span>
    </div>
  );
}
