/**
 * The policy editor's field controls: which server a rule is about, the names
 * it lets through, and the two permission columns. Each edits one piece of a
 * rule's JSON and hands the new value back; none of them validates, since the
 * backend parses every draft with the parser that applies it
 * (`policy_validate`).
 *
 * **Picked, not typed.** A rule that names a server or a table that does not
 * exist grants nothing and says nothing, so every name here is chosen from
 * something real first — a saved connection, the catalog of the server behind
 * it — and typing is the second path, kept for the two things a list cannot
 * offer: a pattern (`v_factura_*`) and a server this computer has no
 * connection to. Even then the field shows what the typed text matches.
 *
 * **Never an invalid draft on the way.** Switching a rule to "a saved
 * connection" or "by hand" does not write `{ host: "" }` — which the parser
 * rejects, and which used to flash "the policy is not valid" at the user for
 * doing nothing wrong. The rule keeps its previous server until a real one is
 * chosen or typed.
 */

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Asterisk, Plug, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Segmented } from "@/components/ui/segmented";
import { Spinner } from "@/components/ui/spinner";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { MICRO_HEADING } from "@/components/ui/styles";
import { DriverBadge, driverLabel } from "@/components/common/DriverBadge";
import { isPattern, matchesOf } from "@/lib/policy/glob";
import { PERMISSIONS, type EndpointJson, type Permission } from "@/lib/policy/draft";
import { cn } from "@/lib/utils";
import type { ConnectionProfile, Driver } from "@/types";

/** A label above its control, with an optional hint under it. */
export function Field({
  label,
  hint,
  aside,
  children,
}: {
  label: string;
  hint?: ReactNode;
  /** Right-aligned on the label's line (a toggle, a count). */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <span className="text-xs font-medium">{label}</span>
        {aside}
      </div>
      {children}
      {hint && <span className="text-3xs leading-snug text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** A titled group of fields inside the rule editor. */
export function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <h3 className={MICRO_HEADING}>{title}</h3>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Server

// `*` is the policy's one wildcard; the matching lives in `lib/policy/glob`,
// shared with the grid's column locks.
export { isPattern, matchesOf };

const sameFile = (a: string, b: string) =>
  a.trim().replace(/\\/g, "/").toLowerCase() === b.trim().replace(/\\/g, "/").toLowerCase();

/** The saved connection a rule's server is, if there is one on this computer. */
export function profileFor(
  endpoint: EndpointJson,
  profiles: ConnectionProfile[],
): ConnectionProfile | undefined {
  if (endpoint === "*") return undefined;
  const saved = profiles.filter((p) => !p.ephemeral);
  if (endpoint.path !== undefined) {
    return saved.find((p) => p.driver === "sqlite" && sameFile(p.database, endpoint.path!));
  }
  const host = (endpoint.host ?? "").trim().toLowerCase();
  return saved.find(
    (p) =>
      p.driver !== "sqlite" &&
      p.host.trim().toLowerCase() === host &&
      (!endpoint.driver || endpoint.driver === p.driver) &&
      (endpoint.port === undefined || endpoint.port === p.port),
  );
}

function endpointOf(p: ConnectionProfile): EndpointJson {
  return p.driver === "sqlite"
    ? { path: p.database }
    : { driver: p.driver, host: p.host, ...(p.port ? { port: p.port } : {}) };
}

/** `mysql · erp.local:3306`, or the file of a SQLite connection. */
export function whereOf(p: ConnectionProfile): string {
  return p.driver === "sqlite"
    ? p.database
    : `${p.driver} · ${p.host}${p.port ? `:${p.port}` : ""}`;
}

/** Same order as the connection form's driver picker. */
const DRIVERS: Driver[] = ["postgres", "mysql", "sqlite", "mongodb", "sqlserver"];
/** Radix reserves `""` for "no value", so "any driver" needs a name. */
const ANY_DRIVER = "any";

/** A driver's logo and name, as the connection form shows it. */
function DriverOption({ driver, children }: { driver: Driver; children?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <DriverBadge driver={driver} />
      {children ?? driverLabel(driver)}
    </span>
  );
}

type EndpointMode = "any" | "saved" | "manual";

/**
 * Which server a rule is about: every one, one of this computer's saved
 * connections (the usual answer), or one typed by hand. The draft only ever
 * receives a complete endpoint.
 */
export function EndpointField({
  value,
  profiles,
  readOnly,
  active,
  connecting,
  onConnect,
  onChange,
}: {
  value: EndpointJson;
  profiles: ConnectionProfile[];
  readOnly: boolean;
  /** Is the matching saved connection open (its catalog feeds the lists)? */
  active: boolean;
  connecting: boolean;
  onConnect: (id: string) => void;
  onChange: (next: EndpointJson) => void;
}) {
  const { t } = useTranslation();
  const saved = profiles.filter((p) => !p.ephemeral);
  const match = profileFor(value, profiles);
  const [mode, setMode] = useState<EndpointMode>(
    value === "*" ? "any" : match ? "saved" : "manual",
  );
  // The typed server lives here, and reaches the draft only once it names
  // something: an empty host is a parse error, not "no server yet".
  const obj = value === "*" ? {} : value;
  const [driver, setDriver] = useState<string>(obj.path !== undefined ? "sqlite" : (obj.driver ?? ""));
  const [host, setHost] = useState(obj.host ?? "");
  const [port, setPort] = useState(obj.port !== undefined ? String(obj.port) : "");
  const [path, setPath] = useState(obj.path ?? "");

  const commitManual = (next: { driver?: string; host?: string; port?: string; path?: string }) => {
    const d = next.driver ?? driver;
    if (d === "sqlite") {
      const p = (next.path ?? path).trim();
      if (p) onChange({ path: p });
      return;
    }
    const h = (next.host ?? host).trim();
    if (!h) return;
    const n = parseInt(next.port ?? port, 10);
    onChange({ ...(d ? { driver: d } : {}), host: h, ...(Number.isFinite(n) ? { port: n } : {}) });
  };

  const pending =
    (mode === "saved" && !match && value !== "*") || (mode !== "any" && value === "*");

  return (
    <Field
      label={t("policyEditor.rule.endpoint")}
      hint={t("policyEditor.rule.endpointHint")}
      aside={
        <Segmented<EndpointMode>
          size="sm"
          aria-label={t("policyEditor.rule.endpoint")}
          value={mode}
          onValueChange={(m) => {
            if (readOnly || m === mode) return;
            setMode(m);
            if (m === "any") onChange("*");
          }}
          options={[
            { value: "any", label: t("policyEditor.rule.endpointAny") },
            { value: "saved", label: t("policyEditor.rule.endpointSaved") },
            { value: "manual", label: t("policyEditor.rule.endpointManual") },
          ]}
        />
      }
    >
      {mode === "any" && (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-2xs text-muted-foreground">
          {t("policyEditor.rule.endpointAnyExplain")}
        </p>
      )}

      {mode === "saved" &&
        (saved.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-2xs text-muted-foreground">
            {t("policyEditor.rule.noSavedConnections")}
          </p>
        ) : (
          <div className="grid gap-2">
            <Select
              value={match?.id ?? ""}
              disabled={readOnly}
              onValueChange={(id) => {
                const p = saved.find((x) => x.id === id);
                if (p) onChange(endpointOf(p));
              }}
            >
              <SelectTrigger
                aria-label={t("policyEditor.rule.endpointSaved")}
                className="h-8 text-xs"
              >
                {match ? (
                  <DriverOption driver={match.driver}>
                    <span className="truncate">{match.name}</span>
                  </DriverOption>
                ) : (
                  <span className="text-muted-foreground">{t("policyEditor.rule.pickConnection")}</span>
                )}
              </SelectTrigger>
              <SelectContent>
                {saved.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="text-xs">
                    <DriverOption driver={p.driver}>
                      <span className="truncate">{p.name}</span>
                      <span className="truncate font-mono text-3xs text-muted-foreground">
                        {whereOf(p)}
                      </span>
                    </DriverOption>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {match && (
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5 text-2xs">
                <span
                  aria-hidden
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    active ? "bg-success" : "bg-muted-foreground/40",
                  )}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                  {whereOf(match)}
                </span>
                {active ? (
                  <span className="shrink-0 text-muted-foreground">
                    {t("policyEditor.rule.catalogReady")}
                  </span>
                ) : (
                  <Button
                    size="xs"
                    variant="ghost"
                    icon={Plug}
                    loading={connecting}
                    className="-my-1 h-6 shrink-0 px-2 text-2xs"
                    onClick={() => onConnect(match.id)}
                  >
                    {t("policyEditor.rule.connectForNames")}
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}

      {mode === "manual" && (
        <div className="grid gap-2 sm:grid-cols-[11rem_minmax(0,1fr)_6rem]">
          <Select
            value={driver || ANY_DRIVER}
            disabled={readOnly}
            onValueChange={(v) => {
              const d = v === ANY_DRIVER ? "" : v;
              setDriver(d);
              commitManual({ driver: d });
            }}
          >
            <SelectTrigger aria-label={t("policyEditor.rule.driver")} className="h-8 text-xs">
              {driver ? (
                <DriverOption driver={driver as Driver} />
              ) : (
                <span>{t("policyEditor.rule.anyDriver")}</span>
              )}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_DRIVER} className="text-xs">
                {t("policyEditor.rule.anyDriver")}
              </SelectItem>
              {DRIVERS.map((d) => (
                <SelectItem key={d} value={d} className="text-xs">
                  <DriverOption driver={d} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {driver === "sqlite" ? (
            <Input
              size="sm"
              className="font-mono sm:col-span-2"
              aria-label={t("policyEditor.rule.path")}
              placeholder={"\\\\srv\\datos\\ventas.db"}
              readOnly={readOnly}
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                commitManual({ path: e.target.value });
              }}
            />
          ) : (
            <>
              <Input
                size="sm"
                aria-label={t("policyEditor.rule.host")}
                placeholder="erp.empresa.local"
                className="font-mono"
                readOnly={readOnly}
                value={host}
                onChange={(e) => {
                  setHost(e.target.value);
                  commitManual({ host: e.target.value });
                }}
              />
              <Input
                size="sm"
                inputMode="numeric"
                aria-label={t("policyEditor.rule.port")}
                placeholder={t("policyEditor.rule.anyPort")}
                readOnly={readOnly}
                value={port}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, "");
                  setPort(v);
                  commitManual({ port: v });
                }}
              />
            </>
          )}
        </div>
      )}

      {pending && !readOnly && (
        <p className="text-3xs text-muted-foreground">
          {value === "*"
            ? t("policyEditor.rule.pendingAny")
            : t("policyEditor.rule.pendingKeeps")}
        </p>
      )}
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Name lists

function Chip({
  name,
  tone,
  tooltip,
  removeLabel,
  onRemove,
}: {
  name: string;
  tone: "known" | "pattern" | "unknown";
  tooltip?: string;
  removeLabel: string;
  onRemove?: () => void;
}) {
  const chip = (
    <span
      className={cn(
        "inline-flex h-6 max-w-full items-center gap-1 rounded-md border pl-1.5 font-mono text-2xs",
        onRemove ? "pr-0.5" : "pr-1.5",
        tone === "known" && "border-border bg-background",
        tone === "pattern" && "border-brand/40 bg-brand/10 text-brand",
        tone === "unknown" && "border-warning/50 bg-warning/10 text-warning",
      )}
    >
      {tone === "pattern" && <Asterisk aria-hidden className="h-3 w-3 shrink-0" />}
      <span className="truncate">{name}</span>
      {onRemove && (
        <IconButton
          flat
          size="xs"
          icon={X}
          label={removeLabel}
          className="h-5 w-5 rounded-sm"
          onClick={onRemove}
        />
      )}
    </span>
  );
  return tooltip ? <SimpleTooltip label={tooltip}>{chip}</SimpleTooltip> : chip;
}

/**
 * A list of names, picked from the server's catalog. With `allLabel` the list
 * can also be absent — "every database", "every table" — which is not the same
 * as an empty list ("none"), so the two are a toggle rather than an empty box
 * that silently means one or the other.
 */
export function NamePicker({
  label,
  hint,
  value,
  allLabel,
  allExplain,
  emptyLabel,
  emptyIsWarning,
  catalog,
  catalogLoading,
  catalogSource,
  noCatalogHint,
  describe,
  readOnly,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string[] | undefined;
  /** When given, `undefined` means "all" and the field offers the toggle. */
  allLabel?: string;
  allExplain?: string;
  /** What an empty list means, in words. */
  emptyLabel: string;
  /** An empty allow-list grants nothing: say it in amber. */
  emptyIsWarning?: boolean;
  /** `null` when there is no open server to read names from. */
  catalog: string[] | null;
  catalogLoading: boolean;
  /** The connection the names come from, for the search placeholder. */
  catalogSource?: string;
  /** Why there is no list to pick from, when there is none. */
  noCatalogHint?: string;
  /**
   * What to say beside a catalog name — "2 of 2 tables", "required", "identity"
   * — and whether it can be picked at all. For the column pickers (ADR #113).
   */
  describe?: (name: string) => { tag?: string; warn?: boolean; disabled?: boolean };
  readOnly: boolean;
  onChange: (next: string[] | undefined) => void;
}) {
  const { t } = useTranslation();
  const all = allLabel !== undefined && value === undefined;
  const list = value ?? [];
  const chosen = useMemo(() => new Set(list.map((v) => v.toLowerCase())), [list]);
  const [filter, setFilter] = useState("");
  const [pattern, setPattern] = useState("");
  useEffect(() => setFilter(""), [catalogSource]);

  const shown = useMemo(() => {
    if (!catalog) return [];
    const f = filter.trim().toLowerCase();
    return f ? catalog.filter((n) => n.toLowerCase().includes(f)) : catalog;
  }, [catalog, filter]);

  const toggle = (name: string, on: boolean) =>
    onChange(on ? [...list, name] : list.filter((v) => v.toLowerCase() !== name.toLowerCase()));

  const typed = pattern.trim();
  const typedMatches = catalog && typed ? matchesOf(typed, catalog) : null;
  const addTyped = () => {
    if (!typed || chosen.has(typed.toLowerCase())) return;
    onChange([...list, typed]);
    setPattern("");
  };

  const toneOf = (name: string): "known" | "pattern" | "unknown" => {
    if (isPattern(name)) return "pattern";
    if (catalog && !name.includes(".") && !catalog.some((c) => c.toLowerCase() === name.toLowerCase())) {
      return "unknown";
    }
    return "known";
  };

  return (
    <Field
      label={label}
      hint={hint}
      aside={
        allLabel !== undefined && (
          <Segmented<"all" | "only">
            size="sm"
            aria-label={label}
            value={all ? "all" : "only"}
            onValueChange={(v) => {
              if (readOnly) return;
              onChange(v === "all" ? undefined : list);
            }}
            options={[
              { value: "all", label: allLabel },
              { value: "only", label: t("policyEditor.rule.onlyThese") },
            ]}
          />
        )
      }
    >
      {all ? (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-2xs text-muted-foreground">
          {allExplain}
        </p>
      ) : (
        <div className="grid gap-2 rounded-md border border-border bg-card/30 p-2">
          {/* What the rule names today. */}
          {list.length === 0 ? (
            <p
              className={cn(
                "px-1 py-0.5 text-2xs",
                emptyIsWarning ? "text-warning" : "text-muted-foreground",
              )}
            >
              {emptyLabel}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {list.map((name) => {
                const tone = toneOf(name);
                const matched = tone === "pattern" && catalog ? matchesOf(name, catalog).length : null;
                return (
                  <Chip
                    key={name}
                    name={name}
                    tone={tone}
                    removeLabel={t("policyEditor.rule.removeName", { name })}
                    tooltip={
                      tone === "unknown"
                        ? t("policyEditor.rule.notOnServer", { source: catalogSource ?? "" })
                        : matched !== null
                          ? t("policyEditor.rule.patternMatches", { count: matched })
                          : undefined
                    }
                    onRemove={readOnly ? undefined : () => toggle(name, false)}
                  />
                );
              })}
            </div>
          )}

          {!readOnly && (
            <>
              {/* The catalog: the safe way to add a name. */}
              {catalogLoading ? (
                <p className="flex items-center gap-2 px-1 text-2xs text-muted-foreground">
                  <Spinner size="sm" />
                  {t("policyEditor.rule.catalogLoading")}
                </p>
              ) : catalog && catalog.length > 0 ? (
                <div className="grid gap-1 border-t border-border pt-2">
                  <SearchField
                    size="xs"
                    value={filter}
                    onValueChange={setFilter}
                    placeholder={t("policyEditor.rule.searchCatalog", { source: catalogSource ?? "" })}
                    aria-label={t("policyEditor.rule.searchCatalog", { source: catalogSource ?? "" })}
                    onClear={() => setFilter("")}
                    clearLabel={t("common.clear")}
                  />
                  <div className="grid max-h-44 grid-cols-1 gap-x-3 overflow-y-auto px-1 py-0.5 sm:grid-cols-2 lg:grid-cols-3">
                    {shown.map((name) => {
                      const about = describe?.(name);
                      return (
                        <div key={name} className="min-w-0 overflow-hidden py-0.5">
                          <Checkbox
                            label={
                              <span className="flex min-w-0 items-baseline gap-1.5">
                                <span className="truncate font-mono text-2xs">{name}</span>
                                {about?.tag && (
                                  <span
                                    className={cn(
                                      "shrink-0 truncate text-3xs",
                                      about.warn ? "text-warning" : "text-muted-foreground",
                                    )}
                                  >
                                    {about.tag}
                                  </span>
                                )}
                              </span>
                            }
                            checked={chosen.has(name.toLowerCase())}
                            disabled={about?.disabled}
                            onChange={(e) => toggle(name, e.target.checked)}
                          />
                        </div>
                      );
                    })}
                    {shown.length === 0 && (
                      <p className="col-span-full py-1 text-2xs text-muted-foreground">
                        {t("policyEditor.rule.catalogNoMatch")}
                      </p>
                    )}
                  </div>
                </div>
              ) : catalog === null && noCatalogHint ? (
                <p className="border-t border-border px-1 pt-2 text-3xs text-muted-foreground">
                  {noCatalogHint}
                </p>
              ) : null}

              {/* A pattern: the one thing the catalog cannot offer. */}
              <div className="grid gap-1 border-t border-border pt-2">
                <div className="flex items-center gap-1.5">
                  <Input
                    size="xs"
                    className="min-w-0 flex-1 font-mono"
                    aria-label={t("policyEditor.rule.addPattern")}
                    placeholder={t("policyEditor.rule.patternPlaceholder")}
                    value={pattern}
                    onChange={(e) => setPattern(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addTyped();
                      }
                    }}
                  />
                  <Button
                    size="xs"
                    variant="outline"
                    icon={Plus}
                    disabled={!typed || chosen.has(typed.toLowerCase())}
                    onClick={addTyped}
                  >
                    {t("policyEditor.rule.add")}
                  </Button>
                </div>
                {typed && (
                  <p
                    className={cn(
                      "px-1 text-3xs",
                      typedMatches && typedMatches.length === 0 ? "text-warning" : "text-muted-foreground",
                    )}
                  >
                    {typedMatches === null
                      ? t("policyEditor.rule.patternUnchecked")
                      : typedMatches.length === 0
                        ? t("policyEditor.rule.patternNone", { source: catalogSource ?? "" })
                        : t("policyEditor.rule.patternSome", {
                            count: typedMatches.length,
                            names: typedMatches.slice(0, 4).join(", "),
                          })}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Permissions

/**
 * What the person (`human`) and their AI (`ai`) may do. The AI never gets
 * more than the person (D1), so an AI permission the person lacks is shown
 * disabled rather than offered and silently ignored by the policy.
 */
export function PermissionGrid({
  human,
  ai,
  readOnly,
  below,
  onChange,
}: {
  human: string[];
  ai: string[];
  readOnly: boolean;
  /**
   * What hangs under a permission's row, indented — the column limits under
   * `insert` and `update` (ADR #113). Nothing for the others.
   */
  below?: (permission: Permission) => ReactNode;
  onChange: (next: { human: string[]; ai: string[] }) => void;
}) {
  const { t } = useTranslation();
  const toggle = (list: string[], p: string, on: boolean) =>
    on ? PERMISSIONS.filter((x) => x === p || list.includes(x)) : list.filter((x) => x !== p);

  return (
    <Field label={t("policyEditor.rule.permissions")} hint={t("policyEditor.rule.permissionsHint")}>
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-3xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">
                {t("policyEditor.rule.permission")}
              </th>
              <th className="w-24 px-3 py-1.5 font-medium">{t("settings.policy.human")}</th>
              <th className="w-24 px-3 py-1.5 font-medium">{t("settings.policy.ai")}</th>
            </tr>
          </thead>
          <tbody>
            {PERMISSIONS.map((p) => {
              const h = human.includes(p);
              const a = ai.includes(p);
              const extra = below?.(p);
              return (
                <Fragment key={p}>
                <tr className="border-t border-border transition-colors hover:bg-accent/30">
                  <td className="px-3 py-1.5">
                    <span className="font-mono">{p}</span>
                    <span className="ml-2 text-3xs text-muted-foreground">
                      {t(`policyEditor.perm.${p}`)}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <Checkbox
                      aria-label={`${t("settings.policy.human")}: ${p}`}
                      checked={h}
                      disabled={readOnly}
                      onChange={(e) => {
                        const nextHuman = toggle(human, p, e.target.checked);
                        // Taking a permission from the person takes it from
                        // their AI too: `ai ∩ human` is what applies.
                        const nextAi = e.target.checked ? ai : ai.filter((x) => x !== p);
                        onChange({ human: nextHuman, ai: nextAi });
                      }}
                    />
                  </td>
                  <td className={cn("px-3 py-1.5 text-center", !h && "opacity-40")}>
                    <Checkbox
                      aria-label={`${t("settings.policy.ai")}: ${p}`}
                      checked={a && h}
                      disabled={readOnly || !h}
                      onChange={(e) =>
                        onChange({ human, ai: toggle(ai, p, e.target.checked) })
                      }
                    />
                  </td>
                </tr>
                {extra && (
                  <tr>
                    <td colSpan={3} className="px-3 pb-3 pt-0.5">
                      <div className="ml-3 border-l-2 border-border pl-3">{extra}</div>
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Field>
  );
}
