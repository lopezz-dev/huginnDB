/**
 * How the app lock's master password is judged before it is sent.
 *
 * The backend's floor is length alone (`vault::MIN_PASSWORD_CHARS`); this asks
 * for a little more, and says what is missing in words rather than a colour.
 * Deliberately not a dictionary check: that would be a new dependency
 * (`zxcvbn` is ~800 KB), and against an offline attack on `vault.json` the
 * defence that matters is Argon2's cost times the password's length. So the
 * advice is the one that survives: make it long, and do not make it one
 * character repeated.
 */

export type StrengthProblem = "tooShort" | "oneKind" | "repetitive";

export interface Strength {
  ok: boolean;
  problems: StrengthProblem[];
  /** 0–4, for the meter. Never the reason a password is refused. */
  score: number;
}

/** Lower case, upper case, digits, and everything else (spaces count). */
function kinds(password: string): number {
  const classes = [/\p{Ll}/u, /\p{Lu}/u, /\p{Nd}/u, /[^\p{Ll}\p{Lu}\p{Nd}]/u];
  return classes.filter((re) => re.test(password)).length;
}

export function assessPassword(password: string, minChars: number): Strength {
  const chars = [...password];
  const problems: StrengthProblem[] = [];
  if (chars.length < minChars) problems.push("tooShort");
  if (chars.length > 0 && kinds(password) < 2) problems.push("oneKind");
  if (chars.length > 0 && new Set(chars).size < Math.min(6, Math.ceil(chars.length / 2))) {
    problems.push("repetitive");
  }
  const lengthPoints = chars.length >= minChars + 8 ? 2 : chars.length >= minChars ? 1 : 0;
  const kindPoints = Math.min(2, Math.max(0, kinds(password) - 1));
  const score = problems.length ? Math.min(1, lengthPoints) : Math.min(4, lengthPoints + kindPoints);
  return { ok: problems.length === 0, problems, score };
}
