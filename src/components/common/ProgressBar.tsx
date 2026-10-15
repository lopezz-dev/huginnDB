/**
 * A determinate progress bar with a caption underneath.
 *
 * Was `connection/dialogs/ImportProgressBar`, private to the two import
 * wizards. It moved here the moment a third surface needed it — publishing a
 * shared origin's document (#155) — which is exactly the criterion convention #28
 * sets for `common/`: cross-domain, and a leaf.
 *
 * The reason a determinate bar exists at all, rather than a spinner, is the same
 * in both places: the work is one 600 000-iteration PBKDF2 derivation per
 * secret, deliberately slow, and a file with a dozen of them takes long enough
 * that "something is happening" is not enough feedback. The caption is a prop
 * because the *unit* differs — profiles being imported, connections being
 * encrypted — while the bar does not.
 */

export function ProgressBar({
  done,
  total,
  label,
}: {
  done: number;
  total: number;
  label: string;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <div className="space-y-1.5">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-3xs text-muted-foreground">{label}</p>
    </div>
  );
}
