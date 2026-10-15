#!/usr/bin/env node
// Regenerates the indexes under engineering/ from each entry's front matter.
//
//   node scripts/engineering-index.mjs          rewrite the indexes in place
//   node scripts/engineering-index.mjs --check  exit 1 if any index is stale
//
// Only the block between `<!-- index:start -->` and `<!-- index:end -->` in each
// README is generated; the prose around it is hand-written and left alone.
// No dependencies on purpose: the front matter is a flat, known shape, so a
// YAML parser would be a dependency bought for eight keys.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "engineering");
const DIRS = { adr: "adr", gotcha: "gotchas", convention: "conventions" };
const LABEL = { adr: "ADR", gotcha: "Gotcha", convention: "Convention" };
const check = process.argv.includes("--check");

function parseEntry(dir, file) {
  const text = fs.readFileSync(path.join(ROOT, dir, file), "utf8");
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) throw new Error(`${dir}/${file}: missing front matter`);
  const meta = {};
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (v.startsWith("[")) meta[k] = v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    else if (v === "null") meta[k] = null;
    else meta[k] = v;
  }
  const rest = text.slice(fm[0].length).replace(/^\n+/, "");
  const h1 = rest.match(/^# \w+ #(\d+): (.+)\n/);
  if (!h1) throw new Error(`${dir}/${file}: missing "# <Type> #N: Title" heading`);
  if (+h1[1] !== +meta.id) throw new Error(`${dir}/${file}: heading #${h1[1]} != front matter id ${meta.id}`);
  if (DIRS[meta.type] !== dir) throw new Error(`${dir}/${file}: type ${meta.type} filed under ${dir}/`);
  const afterH1 = rest.slice(h1[0].length).replace(/^\n+/, "");
  const summary = afterH1.split("\n\n")[0].replace(/\n/g, " ").trim();
  const trap = (afterH1.match(/^\*\*(?:Trap|External trap behind it):\*\* (.+)$/m) || [])[1] ?? null;
  return { ...meta, id: +meta.id, title: h1[2], summary, trap, file, dir };
}

const entries = Object.values(DIRS)
  .flatMap((dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => /^\w+-\d{3}-.+\.md$/.test(f)).map((f) => parseEntry(dir, f)))
  .sort((a, b) => a.id - b.id);

const seen = new Map();
for (const e of entries) {
  if (seen.has(e.id)) throw new Error(`#${e.id} is used twice: ${seen.get(e.id)} and ${e.dir}/${e.file}`);
  seen.set(e.id, `${e.dir}/${e.file}`);
}

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|");
const status = (e) =>
  e.superseded_by ? `${e.status} → #${e.superseded_by}` : e.status;
const link = (e, from) => {
  const rel = path.posix.relative(from, `${e.dir}/${e.file}`);
  return `[${cell(e.title)}](${rel})`;
};

function rootIndex() {
  const rows = entries.map((e) => `| ${e.id} | ${LABEL[e.type]} | ${link(e, ".")} | ${status(e)} | ${e.date} |`);
  const count = (t) => entries.filter((e) => e.type === t).length;
  return [
    `${entries.length} entries: ${count("adr")} ADRs, ${count("gotcha")} gotchas, ${count("convention")} conventions.`,
    "",
    "| # | Type | Title | Status | Date |",
    "| - | ---- | ----- | ------ | ---- |",
    ...rows,
  ].join("\n");
}

function adrIndex() {
  const adrs = entries.filter((e) => e.type === "adr");
  return [
    "| # | Decision | Summary | Status | Date | Tags | Trap |",
    "| - | -------- | ------- | ------ | ---- | ---- | ---- |",
    ...adrs.map(
      (e) =>
        `| ${e.id} | ${link(e, "adr")} | ${cell(e.summary)} | ${status(e)} | ${e.date} | ${e.tags.join(", ")} | ${e.triggered_by_external_trap === "true" ? "yes" : ""} |`,
    ),
  ].join("\n");
}

function gotchaIndex() {
  // Grouped by first tag: a gotcha is looked up by the technology that bit you.
  const traps = entries.filter((e) => e.type === "gotcha" || e.triggered_by_external_trap === "true");
  const groups = new Map();
  for (const e of traps) {
    const g = e.tags[0] ?? "other";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const out = [];
  for (const g of [...groups.keys()].sort()) {
    out.push(`### ${g}`, "", "| # | Entry | Trap | Status |", "| - | ----- | ---- | ------ |");
    for (const e of groups.get(g)) {
      const kind = e.type === "gotcha" ? "Gotcha" : "ADR";
      out.push(`| ${e.id} | ${kind}: ${link(e, "gotchas")} | ${cell(e.trap ?? e.summary)} | ${status(e)} |`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

function conventionIndex() {
  const cs = entries.filter((e) => e.type === "convention");
  return [
    "| # | Convention | Summary | Status | Tags |",
    "| - | ---------- | ------- | ------ | ---- |",
    ...cs.map((e) => `| ${e.id} | ${link(e, "conventions")} | ${cell(e.summary)} | ${status(e)} | ${e.tags.join(", ")} |`),
  ].join("\n");
}

const targets = [
  ["README.md", rootIndex()],
  ["adr/README.md", adrIndex()],
  ["gotchas/README.md", gotchaIndex()],
  ["conventions/README.md", conventionIndex()],
];

let stale = 0;
for (const [rel, body] of targets) {
  const file = path.join(ROOT, rel);
  const src = fs.readFileSync(file, "utf8");
  const re = /(<!-- index:start -->)[\s\S]*?(<!-- index:end -->)/;
  if (!re.test(src)) throw new Error(`engineering/${rel}: missing index markers`);
  const next = src.replace(re, (_, a, b) => `${a}\n${body}\n${b}`);
  if (next !== src) {
    stale++;
    if (check) console.error(`engineering/${rel} is out of date`);
    else fs.writeFileSync(file, next);
  }
}
if (check && stale) {
  console.error("run: node scripts/engineering-index.mjs");
  process.exit(1);
}
