/**
 * The policy editor's draft: the policy **as JSON**, the way the file holds
 * it — never a model of it. The backend validates every draft with the parser
 * that applies the policy (`policy_validate`), so these helpers only have to
 * edit the object faithfully; a field they do not know about rides along
 * untouched, and key order is kept, which is what makes the form and the JSON
 * tab two views of one thing rather than two documents to reconcile.
 *
 * Pure and immutable: every edit returns a new object.
 */

export type EndpointJson =
  | "*"
  | { driver?: string; host?: string; port?: number; path?: string };

export interface RuleJson {
  endpoint: EndpointJson;
  /** Absent: every database. `[]`: none. */
  databases?: string[];
  relations?: { allow?: string[]; deny?: string[] };
  human?: string[];
  ai?: string[];
  dbUser?: string;
  /** Absent per verb: every column. `[]`: none (ADR #113). */
  columns?: { insert?: string[]; update?: string[] };
  [key: string]: unknown;
}

export interface RoleJson {
  rules?: RuleJson[];
  [key: string]: unknown;
}

export interface PolicyJson {
  version?: number;
  defaultRole?: string;
  users?: Record<string, string>;
  roles?: Record<string, RoleJson>;
  unmanagedConnections?: "allow" | "deny";
  [key: string]: unknown;
}

/** In the order the documentation lists them. */
export const PERMISSIONS = [
  "select",
  "insert",
  "update",
  "delete",
  "ddl",
  "export",
  "monitor",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type ParsedDraft =
  | { ok: true; doc: PolicyJson }
  | { ok: false; error: string };

/** The draft text as an object the form can edit, or why it is not one. */
export function parseDraft(text: string): ParsedDraft {
  if (!text.trim()) return { ok: true, doc: {} };
  try {
    const doc: unknown = JSON.parse(text);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      return { ok: false, error: "the policy must be a JSON object" };
    }
    return { ok: true, doc: doc as PolicyJson };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Two-space JSON with a final newline: what the editor writes. */
export function formatDraft(doc: PolicyJson): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** An account as the policy compares it: no `DOMAIN\`, lower case. Mirrors
 *  `policy::model::normalise_user`. */
export function normaliseUser(name: string): string {
  const trimmed = name.trim();
  const slash = trimmed.lastIndexOf("\\");
  return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).toLowerCase();
}

/** A `dbUser` template for one account. Mirrors `expand_db_user`. */
export function expandDbUser(template: string, user: string): string {
  return template.trim().split("{user}").join(normaliseUser(user));
}

export function roleNames(doc: PolicyJson): string[] {
  return Object.keys(doc.roles ?? {});
}

export function rulesOf(doc: PolicyJson, role: string): RuleJson[] {
  return doc.roles?.[role]?.rules ?? [];
}

/** Replace one key of an object, keeping the others where they were. */
function withKey<T>(
  obj: Record<string, T>,
  from: string,
  to: string,
  value: T,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === from) out[to] = value;
    else out[k] = v;
  }
  if (!(from in obj)) out[to] = value;
  return out;
}

export function addRole(doc: PolicyJson, name: string): PolicyJson {
  const roles = doc.roles ?? {};
  if (!name.trim() || name in roles) return doc;
  return { ...doc, roles: { ...roles, [name]: { rules: [] } } };
}

/**
 * Rename a role and everything that points at it: the users in it and
 * `defaultRole`. A rename that left them behind would make the policy invalid
 * ("user … is assigned role …, which the policy does not define").
 */
export function renameRole(doc: PolicyJson, from: string, to: string): PolicyJson {
  const roles = doc.roles ?? {};
  if (!to.trim() || from === to || to in roles || !(from in roles)) return doc;
  const users = Object.fromEntries(
    Object.entries(doc.users ?? {}).map(([u, r]) => [u, r === from ? to : r]),
  );
  return {
    ...doc,
    roles: withKey(roles, from, to, roles[from]!),
    ...(doc.users ? { users } : {}),
    ...(doc.defaultRole === from ? { defaultRole: to } : {}),
  };
}

/** Remove a role. Refused while it is the default role or someone is in it:
 *  the policy would stop being valid. */
export function removeRole(doc: PolicyJson, name: string): PolicyJson {
  if (!canRemoveRole(doc, name)) return doc;
  const { [name]: _removed, ...roles } = doc.roles ?? {};
  return { ...doc, roles };
}

export function canRemoveRole(doc: PolicyJson, name: string): boolean {
  if (doc.defaultRole === name) return false;
  return !Object.values(doc.users ?? {}).includes(name);
}

export function setRules(doc: PolicyJson, role: string, rules: RuleJson[]): PolicyJson {
  const roles = doc.roles ?? {};
  return {
    ...doc,
    roles: { ...roles, [role]: { ...(roles[role] ?? {}), rules } },
  };
}

export function setUser(doc: PolicyJson, account: string, role: string): PolicyJson {
  const users = doc.users ?? {};
  return { ...doc, users: withKey(users, account, account, role) };
}

export function removeUser(doc: PolicyJson, account: string): PolicyJson {
  const { [account]: _removed, ...users } = doc.users ?? {};
  return { ...doc, users };
}

/** Accounts that are the same once the domain and the case are ignored —
 *  the policy refuses those, so the users pane flags them as they are typed. */
export function duplicateUsers(doc: PolicyJson): Set<string> {
  const seen = new Map<string, string>();
  const dupes = new Set<string>();
  for (const account of Object.keys(doc.users ?? {})) {
    const key = normaliseUser(account);
    const first = seen.get(key);
    if (first !== undefined) {
      dupes.add(first);
      dupes.add(account);
    } else seen.set(key, account);
  }
  return dupes;
}

/** A new rule: every server, reading only. */
export function newRule(): RuleJson {
  return { endpoint: "*", human: ["select"], ai: ["select"] };
}

/**
 * The starting point of "Create policy": nobody unlisted gets anything, and
 * the person creating it keeps full access, so the first save cannot lock its
 * author out.
 */
export function templatePolicy(currentUser: string): PolicyJson {
  const users: Record<string, string> = {};
  if (currentUser.trim()) users[currentUser] = "admin";
  return {
    version: 1,
    defaultRole: "none",
    users,
    roles: {
      none: {},
      admin: {
        rules: [
          {
            endpoint: "*",
            human: [...PERMISSIONS],
            ai: ["select"],
          },
        ],
      },
    },
    unmanagedConnections: "deny",
  };
}

export interface DraftChanges {
  rolesAdded: string[];
  rolesRemoved: string[];
  /** Roles whose rules differ. */
  rulesChanged: string[];
  usersAdded: string[];
  usersRemoved: string[];
  usersMoved: { user: string; from: string; to: string }[];
  defaultRole: { from?: string; to?: string } | null;
  unmanaged: { from?: string; to?: string } | null;
  /** A `dbUser` appears where the saved policy had none — older versions of
   *  HuginnDB read that as a broken policy. */
  dbUserIntroduced: boolean;
  /** Column limits appear where the saved policy had none — the same
   *  compatibility break as `dbUser`. */
  columnsIntroduced: boolean;
}

function hasColumns(doc: PolicyJson): boolean {
  return Object.values(doc.roles ?? {}).some((r) =>
    (r.rules ?? []).some((rule) => rule.columns !== undefined),
  );
}

function hasDbUser(doc: PolicyJson): boolean {
  return Object.values(doc.roles ?? {}).some((r) =>
    (r.rules ?? []).some((rule) => rule.dbUser !== undefined),
  );
}

/** What saving `after` over `before` changes, for the confirmation. */
export function summarizeChanges(before: PolicyJson, after: PolicyJson): DraftChanges {
  const rb = before.roles ?? {};
  const ra = after.roles ?? {};
  const ub = before.users ?? {};
  const ua = after.users ?? {};
  return {
    rolesAdded: Object.keys(ra).filter((r) => !(r in rb)),
    rolesRemoved: Object.keys(rb).filter((r) => !(r in ra)),
    rulesChanged: Object.keys(ra).filter(
      (r) => r in rb && JSON.stringify(ra[r]) !== JSON.stringify(rb[r]),
    ),
    usersAdded: Object.keys(ua).filter((u) => !(u in ub)),
    usersRemoved: Object.keys(ub).filter((u) => !(u in ua)),
    usersMoved: Object.keys(ua)
      .filter((u) => u in ub && ub[u] !== ua[u])
      .map((u) => ({ user: u, from: ub[u]!, to: ua[u]! })),
    defaultRole:
      before.defaultRole !== after.defaultRole
        ? { from: before.defaultRole, to: after.defaultRole }
        : null,
    unmanaged:
      before.unmanagedConnections !== after.unmanagedConnections
        ? { from: before.unmanagedConnections, to: after.unmanagedConnections }
        : null,
    dbUserIntroduced: hasDbUser(after) && !hasDbUser(before),
    columnsIntroduced: hasColumns(after) && !hasColumns(before),
  };
}

/** The role an account gets: its own, or the default one. */
export function roleOf(doc: PolicyJson, account: string): string | undefined {
  const key = normaliseUser(account);
  for (const [u, r] of Object.entries(doc.users ?? {})) {
    if (normaliseUser(u) === key) return r;
  }
  return doc.defaultRole;
}
