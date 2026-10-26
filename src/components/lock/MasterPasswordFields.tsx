/**
 * A new master password, typed twice, with what it still lacks said in words.
 * Shared by turning the lock on, changing the password and resetting the
 * vault, so the three ask for the same thing in the same way.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { PasswordInput } from "@/components/common/PasswordInput";
import { Label } from "@/components/ui/label";
import { assessPassword } from "@/lib/lock/strength";
import { cn } from "@/lib/utils";

export function MasterPasswordFields({
  minChars,
  onChange,
  autoFocus = false,
}: {
  minChars: number;
  /** The password once it is acceptable and both fields agree, else `null`. */
  onChange: (password: string | null) => void;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const strength = useMemo(() => assessPassword(password, minChars), [password, minChars]);
  const mismatch = again.length > 0 && again !== password;
  const valid = strength.ok && again === password;

  useEffect(() => {
    onChange(valid ? password : null);
  }, [valid, password, onChange]);

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="lock-new-password" className="text-xs">
          {t("lock.fields.password")}
        </Label>
        <PasswordInput
          id="lock-new-password"
          autoFocus={autoFocus}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="flex gap-1" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={cn(
                "h-1 flex-1 rounded-full bg-muted",
                i < strength.score && (strength.score >= 3 ? "bg-success" : "bg-warning"),
              )}
            />
          ))}
        </div>
        {password.length > 0 && strength.problems.length > 0 && (
          <ul className="space-y-0.5 text-2xs text-muted-foreground">
            {strength.problems.map((p) => (
              <li key={p}>{t(`lock.strength.${p}`, { n: minChars })}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="lock-new-password-again" className="text-xs">
          {t("lock.fields.again")}
        </Label>
        <PasswordInput
          id="lock-new-password-again"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          aria-invalid={mismatch}
        />
        {mismatch && <p className="text-2xs text-destructive">{t("lock.fields.mismatch")}</p>}
      </div>
    </div>
  );
}
