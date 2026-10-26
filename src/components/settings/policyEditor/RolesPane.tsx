/**
 * Roles and their rules: the heart of the policy. Master/detail — the roles
 * on the left, the selected role's rules in the middle, the selected rule's
 * fields on the right — so a role with twelve rules stays one screen.
 *
 * Names of databases and relations are picked from the catalog of the rule's
 * server when that server is one of this computer's saved connections (and it
 * can be opened from here to get it), and can always be given as a pattern:
 * `v_factura_*`, or a table that does not exist yet, is a legitimate rule.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { MICRO_HEADING, REVEAL_ON_HOVER } from "@/components/ui/styles";
import { databaseViewId } from "@/lib/connectionLabel";
import { connectAndWarm } from "@/lib/connection/connectFlow";
import { confirmDestructive } from "@/lib/confirmDestructive";
import {
  addRole,
  canRemoveRole,
  expandDbUser,
  newRule,
  removeRole,
  renameRole,
  roleNames,
  rulesOf,
  setRules,
  type EndpointJson,
  type PolicyJson,
  type RuleJson,
} from "@/lib/policy/draft";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useConnections } from "@/stores/session/connections";
import { globMatches } from "@/lib/policy/glob";
import type { ConnectionProfile } from "@/types";
import {
  ColumnScopeField,
  ColumnWarnings,
  type CatalogColumn,
  type ColumnCatalog,
} from "./columns";
import {
  EndpointField,
  Field,
  FieldGroup,
  isPattern,
  NamePicker,
  PermissionGrid,
  profileFor,
} from "./fields";

/** The driver a rule's endpoint names, if it names one. */
function endpointDriver(e: EndpointJson): string | undefined {
  return e === "*" ? undefined : e.driver;
}

function endpointLabel(
  e: EndpointJson,
  profiles: ConnectionProfile[],
  anyLabel: string,
): string {
  if (e === "*") return anyLabel;
  const p = profileFor(e, profiles);
  if (p) return p.name;
  if (e.path !== undefined) return e.path || "…";
  return [e.host || "…", e.port].filter(Boolean).join(":");
}

/** A relation of the catalog, with the pool id its structure is read through. */
interface CatalogRelation {
  target: string;
  schema: string;
  name: string;
}

/** Database and relation names on the rule's server, best effort. */
function useCatalog(
  profile: ConnectionProfile | undefined,
  databases: string[] | undefined,
): {
  databases: string[] | null;
  relations: string[] | null;
  /** The same relations, with where each one lives — for its columns. */
  relationRefs: CatalogRelation[] | null;
  loading: boolean;
} {
  const [dbs, setDbs] = useState<string[] | null>(null);
  const [rels, setRels] = useState<string[] | null>(null);
  const [refs, setRefs] = useState<CatalogRelation[] | null>(null);
  const [pending, setPending] = useState(0);
  const id = profile?.id;
  const sqlite = profile?.driver === "sqlite";
  useEffect(() => {
    setDbs(null);
    if (!id || sqlite) return;
    let live = true;
    setPending((n) => n + 1);
    api
      .listDatabases(id)
      .then((list) => live && setDbs(list.map((d) => d.name)))
      .catch(() => live && setDbs([]))
      .finally(() => setPending((n) => n - 1));
    return () => {
      live = false;
    };
  }, [id, sqlite]);
  // Relations of the databases the rule names (the first few), or of the
  // connection's own database when it names none.
  const targets = useMemo(() => {
    if (!id) return [] as string[];
    if (sqlite) return [id];
    const named = (databases ?? []).filter((d) => !isPattern(d)).slice(0, 4);
    return named.length > 0 ? named.map((d) => databaseViewId(id, d)) : [id];
  }, [id, sqlite, databases]);
  const key = targets.join("|");
  useEffect(() => {
    setRels(null);
    setRefs(null);
    if (targets.length === 0) return;
    let live = true;
    setPending((n) => n + 1);
    Promise.all(targets.map((t) => api.listTables(t).catch(() => [])))
      .then((lists) => {
        if (!live) return;
        const names = new Set<string>();
        const found: CatalogRelation[] = [];
        lists.forEach((list, i) => {
          for (const t of list) {
            names.add(t.name);
            found.push({ target: targets[i]!, schema: t.schema, name: t.name });
          }
        });
        setRels([...names].sort((a, b) => a.localeCompare(b)));
        setRefs(found);
      })
      .catch(() => {
        if (!live) return;
        setRels([]);
        setRefs([]);
      })
      .finally(() => setPending((n) => n - 1));
    return () => {
      live = false;
    };
    // `key` stands for `targets`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { databases: dbs, relations: rels, relationRefs: refs, loading: pending > 0 };
}

/** How many tables' columns the editor reads for one rule, at most. */
const COLUMN_TABLES_MAX = 8;

/**
 * Whether a rule's relation patterns reach a relation — the same matching as
 * `policy::resolve::relation_allowed`: a pattern with a dot is matched against
 * `schema.name`, one without against the name; `deny` wins.
 */
function ruleReaches(rule: RuleJson, schema: string, name: string): boolean {
  const full = `${schema}.${name}`;
  const hit = (g: string) => (g.includes(".") ? globMatches(g, full) : globMatches(g, name));
  if ((rule.relations?.deny ?? []).some(hit)) return false;
  const allow = rule.relations?.allow;
  return allow === undefined ? true : allow.some(hit);
}

/**
 * The columns of the tables a rule names, for its column limits (ADR #113) —
 * read only once a limit is set, and only for a rule that names its tables:
 * "every column of every table" is no list to pick from.
 */
function useColumnCatalog(
  rule: RuleJson,
  relationRefs: CatalogRelation[] | null,
  catalogLoading: boolean,
): ColumnCatalog {
  const wanted = rule.columns !== undefined;
  const namesTables = rule.relations?.allow !== undefined;
  const reached = useMemo(
    () =>
      wanted && namesTables && relationRefs
        ? relationRefs
            .filter((r) => ruleReaches(rule, r.schema, r.name))
            .slice(0, COLUMN_TABLES_MAX)
        : [],
    // `rule.relations` is what `ruleReaches` reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wanted, namesTables, relationRefs, rule.relations],
  );
  const key = reached.map((r) => `${r.target}|${r.schema}.${r.name}`).join(";");
  const [columns, setColumns] = useState<CatalogColumn[] | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setColumns(null);
    if (reached.length === 0) return;
    let live = true;
    setLoading(true);
    Promise.all(
      reached.map((r) =>
        api
          .getTableStructure(r.target, r.schema || undefined, r.name)
          .then((s) => ({ table: `${r.schema}.${r.name}`, columns: s.columns }))
          .catch(() => ({ table: `${r.schema}.${r.name}`, columns: [] })),
      ),
    )
      .then((tables) => {
        if (!live) return;
        const byName = new Map<string, CatalogColumn & { generatedIn: number }>();
        for (const { table, columns: cols } of tables) {
          for (const c of cols) {
            const k = c.name.toLowerCase();
            const entry = byName.get(k) ?? {
              name: c.name,
              tables: [],
              requiredIn: [],
              identity: false,
              generatedIn: 0,
            };
            entry.tables.push(table);
            if (c.autoIncrement) entry.generatedIn += 1;
            else if (!c.nullable && (c.default ?? null) === null) entry.requiredIn.push(table);
            byName.set(k, entry);
          }
        }
        setColumns(
          [...byName.values()].map(({ generatedIn, ...c }) => ({
            ...c,
            identity: generatedIn > 0 && generatedIn === c.tables.length,
          })),
        );
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // `key` stands for `reached`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return {
    columns: reached.length > 0 ? columns : null,
    tables: reached.map((r) => `${r.schema}.${r.name}`),
    loading: loading || (wanted && namesTables && catalogLoading && relationRefs === null),
    reason: !namesTables
      ? "noTables"
      : relationRefs === null
        ? "closed"
        : reached.length === 0
          ? "noMatch"
          : null,
  };
}

/**
 * A selectable entry of the roles or rules list: a small bordered button,
 * tinted when selected, with its actions inside the same outline so the hover
 * covers the whole thing rather than a strip of it.
 */
function PickItem({
  active,
  onSelect,
  actions,
  children,
}: {
  active: boolean;
  onSelect: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group/row flex items-center rounded-lg border transition-colors",
        active
          ? "border-brand/40 bg-brand/10"
          : "border-transparent hover:border-border hover:bg-accent/50",
      )}
    >
      <Button
        flat
        variant="ghost"
        size="xs"
        aria-pressed={active}
        className="h-auto min-w-0 flex-1 justify-start rounded-lg px-2.5 py-1.5 text-left font-normal hover:bg-transparent"
        onClick={onSelect}
      >
        <span className="flex w-full min-w-0 items-center gap-2">{children}</span>
      </Button>
      {actions && (
        <span className={cn("flex shrink-0 items-center pr-1", !active && REVEAL_ON_HOVER.row)}>
          {actions}
        </span>
      )}
    </div>
  );
}

/** A column of the master/detail: a titled, bordered list. */
function ListPanel({
  title,
  count,
  addLabel,
  onAdd,
  children,
}: {
  title: string;
  count?: number;
  addLabel: string;
  onAdd?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card/30">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border pl-3 pr-1.5">
        <span className={MICRO_HEADING}>
          {title}
          {count !== undefined && <span className="ml-1.5 font-normal">{count}</span>}
        </span>
        {onAdd && <IconButton size="xs" icon={Plus} label={addLabel} onClick={onAdd} />}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">{children}</div>
    </div>
  );
}

function RuleEditor({
  rule,
  profiles,
  exampleUser,
  readOnly,
  onChange,
}: {
  rule: RuleJson;
  profiles: ConnectionProfile[];
  exampleUser: string;
  readOnly: boolean;
  onChange: (next: RuleJson) => void;
}) {
  const { t } = useTranslation();
  const active = useConnections((s) => s.active);
  const connecting = useConnections((s) => s.connecting);
  const match = profileFor(rule.endpoint, profiles);
  const open = match && active.has(match.id) ? match : undefined;
  const catalog = useCatalog(open, rule.databases);
  const columnCatalog = useColumnCatalog(rule, catalog.relationRefs, catalog.loading);
  const source = open?.name;
  const noCatalogHint =
    rule.endpoint === "*"
      ? t("policyEditor.rule.noCatalogAny")
      : match
        ? t("policyEditor.rule.noCatalogClosed", { name: match.name })
        : t("policyEditor.rule.noCatalogManual");
  const patch = (p: Partial<RuleJson>) => {
    const next: RuleJson = { ...rule, ...p };
    for (const k of Object.keys(p) as (keyof RuleJson)[]) {
      if (p[k] === undefined) delete next[k];
    }
    onChange(next);
  };
  const relations = rule.relations ?? {};
  const setRelations = (r: { allow?: string[]; deny?: string[] }) => {
    const clean: { allow?: string[]; deny?: string[] } = {};
    if (r.allow !== undefined) clean.allow = r.allow;
    if (r.deny && r.deny.length > 0) clean.deny = r.deny;
    patch({ relations: Object.keys(clean).length > 0 ? clean : undefined });
  };
  const sqlite = open?.driver === "sqlite" || (rule.endpoint !== "*" && rule.endpoint.path !== undefined);

  return (
    <div className="grid max-w-3xl gap-6">
      <FieldGroup title={t("policyEditor.rule.groupWhere")}>
        <EndpointField
          value={rule.endpoint}
          profiles={profiles}
          readOnly={readOnly}
          active={!!open}
          connecting={!!match && connecting.has(match.id)}
          onConnect={(id) => void connectAndWarm(id)}
          onChange={(endpoint) => patch({ endpoint })}
        />
      </FieldGroup>

      <FieldGroup title={t("policyEditor.rule.groupWhat")}>
        {!sqlite && (
          <NamePicker
            label={t("policyEditor.rule.databases")}
            allLabel={t("policyEditor.rule.allDatabases")}
            allExplain={t("policyEditor.rule.allDatabasesExplain")}
            emptyLabel={t("policyEditor.rule.noDatabases")}
            emptyIsWarning
            value={rule.databases}
            catalog={catalog.databases}
            catalogLoading={catalog.loading && catalog.databases === null}
            catalogSource={source}
          noCatalogHint={noCatalogHint}
            readOnly={readOnly}
            onChange={(databases) => patch({ databases })}
          />
        )}
        <NamePicker
          label={t("policyEditor.rule.allow")}
          hint={t("policyEditor.rule.allowHint")}
          allLabel={t("policyEditor.rule.allRelations")}
          allExplain={t("policyEditor.rule.allRelationsExplain")}
          emptyLabel={t("policyEditor.rule.noRelations")}
          emptyIsWarning
          value={relations.allow}
          catalog={catalog.relations}
          catalogLoading={catalog.loading && catalog.relations === null}
          catalogSource={source}
          noCatalogHint={noCatalogHint}
          readOnly={readOnly}
          onChange={(allow) => setRelations({ ...relations, allow })}
        />
        <NamePicker
          label={t("policyEditor.rule.deny")}
          hint={t("policyEditor.rule.denyHint")}
          emptyLabel={t("policyEditor.rule.noDeny")}
          value={relations.deny ?? []}
          catalog={catalog.relations}
          catalogLoading={catalog.loading && catalog.relations === null}
          catalogSource={source}
          noCatalogHint={noCatalogHint}
          readOnly={readOnly}
          onChange={(deny) => setRelations({ ...relations, deny: deny ?? [] })}
        />
      </FieldGroup>

      <FieldGroup title={t("policyEditor.rule.groupCan")}>
        <PermissionGrid
          human={rule.human ?? []}
          ai={rule.ai ?? []}
          readOnly={readOnly}
          below={(p) =>
            (p === "insert" || p === "update") && (rule.human ?? []).includes(p) ? (
              <ColumnScopeField
                verb={p}
                rule={rule}
                catalog={columnCatalog}
                catalogSource={source}
                closedHint={noCatalogHint}
                mssql={open?.driver === "sqlserver" || endpointDriver(rule.endpoint) === "sqlserver"}
                readOnly={readOnly}
                onChange={onChange}
              />
            ) : null
          }
          onChange={({ human, ai }) => patch({ human, ai })}
        />
        <ColumnWarnings
          rule={rule}
          catalog={columnCatalog}
          readOnly={readOnly}
          onChange={onChange}
        />
      </FieldGroup>

      <FieldGroup title={t("policyEditor.rule.groupAs")}>
        <Field
          label={t("policyEditor.rule.dbUser")}
          hint={
            rule.dbUser?.trim()
              ? t("policyEditor.rule.dbUserExample", {
                  account: exampleUser,
                  user: expandDbUser(rule.dbUser, exampleUser),
                })
              : t("policyEditor.rule.dbUserHint")
          }
        >
          <Input
            size="sm"
            className="max-w-sm font-mono"
            aria-label={t("policyEditor.rule.dbUser")}
            placeholder="{user}"
            readOnly={readOnly}
            value={rule.dbUser ?? ""}
            onChange={(e) => patch({ dbUser: e.target.value === "" ? undefined : e.target.value })}
          />
        </Field>
      </FieldGroup>
    </div>
  );
}

export function RolesPane({
  doc,
  exampleUser,
  readOnly,
  onChange,
}: {
  doc: PolicyJson;
  exampleUser: string;
  readOnly: boolean;
  onChange: (next: PolicyJson) => void;
}) {
  const { t } = useTranslation();
  const profiles = useConnections((s) => s.profiles);
  const roles = roleNames(doc);
  const [role, setRole] = useState<string | null>(roles[0] ?? null);
  const [ruleIndex, setRuleIndex] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const selected = role && roles.includes(role) ? role : (roles[0] ?? null);
  const rules = selected ? rulesOf(doc, selected) : [];
  const rule = rules[Math.min(ruleIndex, rules.length - 1)];
  const anyLabel = t("policyEditor.rule.endpointAny");

  const commitRename = () => {
    if (renaming && newName.trim() && newName !== renaming) {
      onChange(renameRole(doc, renaming, newName.trim()));
      setRole(newName.trim());
    }
    setRenaming(null);
  };

  const addNewRole = () => {
    let n = 1;
    while (roleNames(doc).includes(`role${n}`)) n += 1;
    onChange(addRole(doc, `role${n}`));
    setRole(`role${n}`);
    setRuleIndex(0);
    setRenaming(`role${n}`);
    setNewName(`role${n}`);
  };

  /** "2 databases · select, insert" — what a rule grants, at a glance. */
  const summary = (r: RuleJson) => {
    const dbs =
      r.databases === undefined
        ? t("policyEditor.rules.allDbs")
        : t("policyEditor.rules.dbCount", { count: r.databases.length });
    // A verb limited to some columns says how many: "update (2 col.)".
    const human = (r.human ?? []).map((p) => {
      const limit = r.columns?.[p as "insert" | "update"];
      return limit === undefined
        ? p
        : t("policyEditor.rules.columnCount", { verb: p, count: limit.length });
    });
    return `${dbs} · ${human.length > 0 ? human.join(", ") : t("policyEditor.rules.nothing")}`;
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[210px_250px_minmax(0,1fr)] gap-3 overflow-hidden">
      <ListPanel
        title={t("policyEditor.roles.title")}
        count={roles.length}
        addLabel={t("policyEditor.roles.add")}
        onAdd={readOnly ? undefined : addNewRole}
      >
        {roles.length === 0 && (
          <p className="px-2 py-1.5 text-2xs text-muted-foreground">{t("policyEditor.roles.none")}</p>
        )}
        {roles.map((r) =>
          renaming === r ? (
            <Input
              key={r}
              size="xs"
              autoFocus
              aria-label={t("policyEditor.roles.rename")}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <PickItem
              key={r}
              active={r === selected}
              onSelect={() => {
                setRole(r);
                setRuleIndex(0);
              }}
              actions={
                !readOnly && (
                  <>
                    <IconButton
                      flat
                      size="xs"
                      icon={Pencil}
                      label={t("policyEditor.roles.rename")}
                      onClick={() => {
                        setRenaming(r);
                        setNewName(r);
                      }}
                    />
                    <IconButton
                      flat
                      size="xs"
                      icon={Trash2}
                      tone="destructive"
                      label={
                        canRemoveRole(doc, r)
                          ? t("policyEditor.roles.remove")
                          : t("policyEditor.roles.inUse")
                      }
                      disabled={!canRemoveRole(doc, r)}
                      onClick={async () => {
                        const count = rulesOf(doc, r).length;
                        const ok = await confirmDestructive(
                          t("policyEditor.roles.confirmRemove", { role: r, count }),
                        );
                        if (ok) onChange(removeRole(doc, r));
                      }}
                    />
                  </>
                )
              }
            >
              <span className="min-w-0 flex-1 truncate text-xs">{r}</span>
              <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">
                {rulesOf(doc, r).length}
              </span>
            </PickItem>
          ),
        )}
      </ListPanel>

      <ListPanel
        title={t("policyEditor.rules.title")}
        count={selected ? rules.length : undefined}
        addLabel={t("policyEditor.rules.add")}
        onAdd={
          selected && !readOnly
            ? () => {
                onChange(setRules(doc, selected, [...rules, newRule()]));
                setRuleIndex(rules.length);
              }
            : undefined
        }
      >
        {selected && rules.length === 0 && (
          <p className="px-2 py-1.5 text-2xs text-muted-foreground">{t("policyEditor.rules.none")}</p>
        )}
        {rules.map((r, i) => (
          <PickItem
            key={i}
            active={i === ruleIndex}
            onSelect={() => setRuleIndex(i)}
            actions={
              !readOnly && (
                <IconButton
                  flat
                  size="xs"
                  icon={Trash2}
                  tone="destructive"
                  label={t("policyEditor.rules.remove")}
                  onClick={async () => {
                    const ok = await confirmDestructive(
                      t("policyEditor.rules.confirmRemove", {
                        rule: endpointLabel(r.endpoint, profiles, anyLabel),
                        role: selected!,
                        grants: summary(r),
                      }),
                    );
                    if (!ok) return;
                    onChange(setRules(doc, selected!, rules.filter((_, j) => j !== i)));
                    setRuleIndex(Math.max(0, i - 1));
                  }}
                />
              )
            }
          >
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-xs">
                {endpointLabel(r.endpoint, profiles, anyLabel)}
              </span>
              <span className="truncate text-3xs text-muted-foreground">{summary(r)}</span>
            </span>
          </PickItem>
        ))}
      </ListPanel>

      <div className="min-h-0 overflow-y-auto rounded-lg border border-border px-5 py-4">
        {selected && rule ? (
          <RuleEditor
            key={`${selected}:${ruleIndex}`}
            rule={rule}
            profiles={profiles}
            exampleUser={exampleUser}
            readOnly={readOnly}
            onChange={(next) =>
              onChange(
                setRules(
                  doc,
                  selected,
                  rules.map((r, j) => (j === ruleIndex ? next : r)),
                ),
              )
            }
          />
        ) : (
          <p className="text-2xs text-muted-foreground">
            {selected ? t("policyEditor.rules.pick") : t("policyEditor.roles.none")}
          </p>
        )}
      </div>
    </div>
  );
}
