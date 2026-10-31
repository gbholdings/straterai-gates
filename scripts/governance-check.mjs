#!/usr/bin/env node
// Governance gates. Node >= 20, no dependencies. The canonical copy lives in gbholdings/straterai-gates;
// packs keep a copy that `gates-sync.mjs --check` holds equal to it.
//
// Exit codes: 0 pass, 1 the check failed, 2 usage error or a missing input (fail closed),
// 4 an evidence file that cannot be parsed (left untouched).
//
// Contracts are ODCS YAML. Node has no YAML parser and this script has no dependencies, so a .yaml/.yml
// contract is read through Python's PyYAML (safe_load), which datacontract-cli installs. No Python with
// PyYAML exits 2. A .json contract is read directly. Set GOVERNANCE_PYTHON to pick the interpreter.
//
// Python runs isolated (-I: no script or working directory on sys.path, no PYTHON* variables, no user
// site-packages) from the system temp directory, so a yaml.py or json.py in the repository under review
// is never the module that loads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

export const VERSION = "1.2.0";
const RESULTS = ["pass", "fail", "not_run"];
const DEFAULT_EVIDENCE = "governance/evidence.json";

class Exit extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// `repeat` names flags that may be given more than once; they come back as arrays. A flag given twice
// that is not repeatable is a usage error, so a typo cannot silently override the first value.
function parseFlags(argv, known, repeat = []) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Exit(2, `unexpected argument: ${a}`);
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (!known.includes(name)) throw new Exit(2, `unknown flag: --${name}`);
    let value;
    if (eq !== -1) value = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) value = argv[++i];
    else throw new Exit(2, `--${name} needs a value`);
    if (value === "") throw new Exit(2, `--${name} needs a non-empty value`);
    if (repeat.includes(name)) (out[name] ??= []).push(value);
    else if (name in out) throw new Exit(2, `--${name} given twice`);
    else out[name] = value;
  }
  return out;
}

function headCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return process.env.GITHUB_SHA || "unknown";
  }
}

// A14. The file is a JSON array that only grows. Read, validate, append, verify nothing earlier
// changed, then write through a temp file so a crash never leaves half a file.
export function evidenceAppend(argv, env = process.env) {
  const f = parseFlags(argv, ["check", "result", "run-link", "commit", "detail", "file", "date"]);
  if (!f.check) throw new Exit(2, "evidence append: --check <plugin>:<skill>/<gate> is required");
  if (!RESULTS.includes(f.result)) throw new Exit(2, `evidence append: --result must be one of ${RESULTS.join(", ")}`);
  const file = f.file ?? env.GOVERNANCE_EVIDENCE_FILE ?? DEFAULT_EVIDENCE;
  const date = f.date ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(date))) throw new Exit(2, `evidence append: --date is not a date: ${date}`);

  let entries = [];
  if (fs.existsSync(file)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw new Exit(4, `evidence file ${file} is not valid JSON and was left untouched: ${e.message}`);
    }
    if (!Array.isArray(parsed) || parsed.some((x) => x === null || typeof x !== "object" || Array.isArray(x))) {
      throw new Exit(4, `evidence file ${file} is not a JSON array of entries and was left untouched`);
    }
    entries = parsed;
  }
  const entry = {
    check: f.check,
    date,
    result: f.result,
    run_link: f["run-link"] ?? null,
    commit: f.commit ?? headCommit(),
    detail: f.detail ?? "",
  };
  const next = [...entries, entry];
  const text = JSON.stringify(next, null, 2) + "\n";
  // Refuse to proceed if the write would alter or drop an earlier entry.
  const back = JSON.parse(text);
  if (back.length !== entries.length + 1 || entries.some((e, i) => JSON.stringify(e) !== JSON.stringify(back[i]))) {
    throw new Exit(4, "refusing to write: an earlier entry would change");
  }
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return `appended ${entry.check} ${entry.result} to ${file} (${next.length} entries)`;
}

// ---------------------------------------------------------------------------------------------------
// Reading inputs

const PY_LOAD = [
  "import json, sys, datetime",
  "import yaml",
  "def d(o):",
  "    if isinstance(o, (datetime.date, datetime.datetime)): return o.isoformat()",
  "    raise TypeError(type(o).__name__)",
  "with open(sys.argv[1], encoding='utf-8') as f: data = yaml.safe_load(f)",
  "json.dump(data, sys.stdout, default=d)",
].join("\n");

// An explicit GOVERNANCE_PYTHON is the only one tried: a wrong path fails instead of falling through.
function pythonCandidates(env) {
  return env.GOVERNANCE_PYTHON ? [env.GOVERNANCE_PYTHON] : ["python3", "python"];
}

export function readStructured(file, env = process.env) {
  if (!fs.existsSync(file)) throw new Exit(2, `${file}: no such file`);
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink()) throw new Exit(1, `${file}: is a symlink; a contract must be a regular file`);
  if (!st.isFile()) throw new Exit(2, `${file}: not a file`);
  if (/\.json$/i.test(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw new Exit(1, `${file}: not valid JSON: ${e.message}`);
    }
  }
  let lastErr = "";
  const pyEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !/^PYTHON/i.test(k)));
  for (const py of pythonCandidates(env)) {
    const r = spawnSync(py, ["-I", "-c", PY_LOAD, path.resolve(file)], { cwd: os.tmpdir(), env: pyEnv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error) {
      lastErr = r.error.message;
      continue;
    }
    if (r.status === 0) return JSON.parse(r.stdout);
    if (/No module named ['"]?yaml/.test(r.stderr)) {
      lastErr = `${py} has no PyYAML`;
      continue;
    }
    throw new Exit(1, `${file}: not valid YAML: ${r.stderr.trim().split("\n").pop()}`);
  }
  throw new Exit(2, `cannot read ${file}: needs Python with PyYAML (pip install pyyaml, or set GOVERNANCE_PYTHON). Last error: ${lastErr}`);
}

function readJson(file, what) {
  if (!fs.existsSync(file)) throw new Exit(2, `${what} ${file}: no such file`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Exit(2, `${what} ${file}: not valid JSON: ${e.message}`);
  }
}

const isContractFile = (name) => /\.odcs\.(ya?ml|json)$/i.test(name);

// Every ODCS file under a directory. A symlink anywhere under it is a finding, not something to follow.
function contractsUnder(dir, problems) {
  if (!fs.existsSync(dir)) throw new Exit(2, `--contracts ${dir}: no such directory`);
  if (!fs.lstatSync(dir).isDirectory()) throw new Exit(2, `--contracts ${dir}: not a directory`);
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        if (isContractFile(e.name) || fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()) problems.push(`${p}: is a symlink; contracts must be regular files`);
      } else if (e.isDirectory()) walk(p);
      else if (e.isFile() && isContractFile(e.name)) found.push(p);
    }
  };
  walk(dir);
  return found;
}

// ---------------------------------------------------------------------------------------------------
// ODCS fields, as `datacontract lint` (datacontract-cli 1.2.8) accepts them:
// - owner: a `team` member whose `role` is `owner`. In ODCS v3.0.x `team` is a list of members; from
//   v3.1.0 it is an object with `members`. A top-level `owner:` key fails lint ("Additional properties
//   are not allowed"). A member whose `dateOut` is on or before today has left and does not count.
// - consumers: a top-level `customProperties` entry `{ property: consumers, value: [ { repo, team } ] }`.
//   A top-level `consumers:` key fails lint the same way.

function teamMembers(contract) {
  const t = contract?.team;
  if (Array.isArray(t)) return t;
  if (t && typeof t === "object" && Array.isArray(t.members)) return t.members;
  return [];
}

export function contractOwners(contract, today = new Date().toISOString().slice(0, 10)) {
  return teamMembers(contract)
    .filter((m) => m && typeof m === "object")
    .filter((m) => typeof m.role === "string" && m.role.trim().toLowerCase() === "owner")
    .filter((m) => typeof m.username === "string" && m.username.trim() !== "")
    .filter((m) => !(typeof m.dateOut === "string" && m.dateOut.slice(0, 10) <= today))
    .map((m) => m.username.trim());
}

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

// Returns { consumers: [{repo, team}], problems: [] }. Absent is an empty list; malformed is a problem.
export function contractConsumers(contract) {
  const problems = [];
  const props = contract?.customProperties;
  if (props === undefined || props === null) return { consumers: [], problems };
  if (!Array.isArray(props)) return { consumers: [], problems: ["customProperties is not a list"] };
  const entries = props.filter((p) => p && typeof p === "object" && p.property === "consumers");
  if (entries.length > 1) problems.push("customProperties lists `consumers` more than once");
  if (!entries.length) return { consumers: [], problems };
  const value = entries[0].value;
  if (!Array.isArray(value)) return { consumers: [], problems: [...problems, "customProperties consumers: value must be a list of { repo, team }"] };
  const consumers = [];
  value.forEach((c, i) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) return problems.push(`consumers[${i}] is not a { repo, team } mapping`);
    const repo = typeof c.repo === "string" ? c.repo.trim() : "";
    const team = typeof c.team === "string" ? c.team.trim() : "";
    if (!repo && !team) return problems.push(`consumers[${i}] names neither a repo nor a team`);
    if (repo && !REPO_RE.test(repo)) return problems.push(`consumers[${i}].repo is not owner/name: ${JSON.stringify(c.repo)}`);
    consumers.push({ repo, team });
  });
  return { consumers, problems };
}

// ---------------------------------------------------------------------------------------------------
// owner: every contract has an owner; every dbt model of the project has meta.owner.

export function ownerCheck(argv, env = process.env) {
  const f = parseFlags(argv, ["contracts", "contract", "manifest"], ["contract"]);
  if (!f.contracts && !f.contract && !f.manifest) throw new Exit(2, "owner: give --contracts <dir>, --contract <file> (repeatable) or --manifest <manifest.json>");
  const problems = [];
  const files = [...(f.contracts ? contractsUnder(f.contracts, problems) : []), ...(f.contract ?? [])];
  if (f.contracts && !f.contract && !files.length && !f.manifest && !problems.length) {
    throw new Exit(2, `owner: no *.odcs.yaml, *.odcs.yml or *.odcs.json under ${f.contracts}; nothing was checked`);
  }
  let models = 0;
  for (const file of files) {
    let c;
    try {
      c = readStructured(file, env);
    } catch (e) {
      if (e instanceof Exit && e.code === 1) {
        problems.push(e.message);
        continue;
      }
      throw e;
    }
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      problems.push(`${file}: not a mapping`);
      continue;
    }
    if (!contractOwners(c).length) problems.push(`${file}: no owner. Add a team member with role: owner (ODCS v3.0.x: team: [{ username, role: owner }]; v3.1+: team: { name, members: [{ username, role: owner }] }).`);
  }
  if (f.manifest) {
    const m = readJson(f.manifest, "--manifest");
    if (!m || typeof m.nodes !== "object" || m.nodes === null) throw new Exit(2, `--manifest ${f.manifest}: no nodes; is it a dbt manifest.json?`);
    const project = m.metadata?.project_name;
    for (const [id, n] of Object.entries(m.nodes)) {
      if (n?.resource_type !== "model") continue;
      if (project && n.package_name !== project) continue;
      models++;
      const owner = n.config?.meta?.owner ?? n.meta?.owner;
      const ok = (typeof owner === "string" && owner.trim() !== "") || (Array.isArray(owner) && owner.some((o) => typeof o === "string" && o.trim() !== ""));
      if (!ok) problems.push(`${id}: no meta.owner (${n.original_file_path ?? "model"})`);
    }
    if (!models) throw new Exit(2, `--manifest ${f.manifest}: no models of project ${project ?? "(unknown)"}; nothing was checked`);
  }
  if (problems.length) throw new Exit(1, `owner: ${problems.length} problem(s)\n${problems.map((p) => `  ${p}`).join("\n")}`);
  return `owner: ok (${files.length} contract(s), ${models} model(s))`;
}

// ---------------------------------------------------------------------------------------------------
// Types. A logical type is one of ODCS's (string, date, timestamp, time, number, integer, object,
// array, boolean). date, timestamp and time compare as one class: ODCS v3.0.2 has only `date`, so a
// timestamp column is `date` there and `timestamp` from v3.1.0.

const TEMPORAL = ["date", "timestamp", "time"];
const ODCS_LOGICAL = ["string", ...TEMPORAL, "number", "integer", "object", "array", "boolean"];

function logicalClass(t) {
  return TEMPORAL.includes(t) ? "temporal" : t;
}

// Physical type, normalized so spellings of one type compare equal. Precision stays when given.
const ALIASES = [
  [/^int4$|^int$|^integer$|^serial$|^serial4$/, "integer"],
  [/^int8$|^bigint$|^bigserial$|^serial8$/, "bigint"],
  [/^int2$|^smallint$|^smallserial$|^serial2$/, "smallint"],
  [/^float8$|^double precision$|^double$/, "double precision"],
  [/^float4$|^real$/, "real"],
  [/^bool$|^boolean$/, "boolean"],
  [/^character varying$|^varchar$/, "varchar"],
  [/^character$|^char$|^bpchar$/, "char"],
  [/^timestamp with time zone$|^timestamptz$/, "timestamptz"],
  [/^timestamp without time zone$|^timestamp$/, "timestamp"],
  [/^time with time zone$|^timetz$/, "timetz"],
  [/^time without time zone$|^time$/, "time"],
  [/^numeric$|^decimal$/, "numeric"],
];

export function normPhysical(t) {
  if (typeof t !== "string") return null;
  let s = t.trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*\(\s*/g, "(").replace(/\s*,\s*/g, ",").replace(/\s*\)/g, ")");
  if (!s) return null;
  // A Postgres array (`text[]`, `varchar(20)[]`) normalizes its element type and keeps the brackets.
  const arr = /(?:\s*\[\s*\d*\s*\])+$/.exec(s);
  const dims = arr ? "[]".repeat((arr[0].match(/\[/g) ?? []).length) : "";
  if (arr) s = s.slice(0, arr.index).trim();
  const m = /^([a-z0-9_ ]+?)(\(.*\))?((?: with| without) time zone)?$/.exec(s);
  if (!m) return { base: s + dims, args: null };
  let base = (m[1] + (m[3] ?? "")).trim();
  for (const [re, to] of ALIASES) if (re.test(base)) base = to;
  return { base: base + dims, args: m[2] ? m[2].slice(1, -1) : null };
}

// Equal when the base types match and, if both carry arguments (length, precision), those match too.
// A contract that says `timestamp` accepts the source's `timestamp(3)`; one that says `varchar(50)`
// does not accept `varchar(255)`.
export function physicalAgrees(contractType, sourceType) {
  const a = normPhysical(contractType);
  const b = normPhysical(sourceType);
  if (!a || !b) return true;
  if (a.base !== b.base) return false;
  if (a.args !== null && b.args !== null && a.args !== b.args) return false;
  if (a.args !== null && b.args === null) return false;
  return true;
}

// The logical classes a warehouse or database type can hold. NUMBER(p,0) and friends hold integers,
// so they accept integer and number. An unknown type returns null: the comparison cannot be made.
export function logicalFromPhysical(t) {
  const n = normPhysical(t);
  if (!n) return null;
  const b = n.base;
  if (/^(array|repeated)\b|\[\]$/.test(b) || /^array</.test(t.trim().toLowerCase())) return ["array"];
  if (/^(struct|record|map|object|variant|json|jsonb|super|hstore)\b/.test(b) || /^(struct|map)</.test(t.trim().toLowerCase())) return ["object"];
  if (/^(integer|bigint|smallint|tinyint|byteint|int64|int32|int16|hugeint|ubigint|uinteger|usmallint|utinyint|long|short|byte)$/.test(b)) return ["integer"];
  if (/^(numeric|number|bignumeric|bigdecimal)$/.test(b)) {
    if (n.args !== null && /^\d+,0$/.test(n.args)) return ["integer", "number"];
    return ["number"];
  }
  if (/^(double precision|real|float|float4|float8|float32|float64|money|smallmoney)$/.test(b)) return ["number"];
  if (b === "boolean" || b === "bit") return ["boolean"];
  if (/^(date|datetime|datetime2|datetimeoffset|smalldatetime|timestamp|timestamptz|timestamp_ntz|timestamp_ltz|timestamp_tz|time|timetz|interval)$/.test(b)) return TEMPORAL;
  if (/^(text|varchar|char|nvarchar|nchar|ntext|string|uuid|citext|uniqueidentifier|clob|tinytext|mediumtext|longtext|enum|inet|cidr|macaddr|xml|geography|geometry)$/.test(b)) return ["string"];
  if (/^(bytea|bytes|binary|varbinary|blob|image|longblob)$/.test(b)) return ["string"];
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Prisma schema reader. Reads models (and views), their scalar fields, @map / @@map, @db.<native type>,
// `?` (optional), `[]` (list), @ignore / @@ignore and the datasource provider. Relation fields (whose
// type is another model or a composite type) are not columns and are skipped.

function stripComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && inStr) {
      i++;
      continue;
    }
    if (ch === '"') inStr = !inStr;
    else if (!inStr && ch === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

const PRISMA_SCALARS = {
  String: { logical: ["string"], pg: "text" },
  Boolean: { logical: ["boolean"], pg: "boolean" },
  Int: { logical: ["integer"], pg: "integer" },
  BigInt: { logical: ["integer"], pg: "bigint" },
  Float: { logical: ["number"], pg: "double precision" },
  Decimal: { logical: ["number"], pg: "numeric(65,30)" },
  DateTime: { logical: TEMPORAL, pg: "timestamp(3)" },
  Json: { logical: ["object", "array"], pg: "jsonb" },
  Bytes: { logical: ["string"], pg: "bytea" },
};

// @db.<Name>(args) to a Postgres type name. Source: https://www.prisma.io/docs/orm/reference/prisma-schema-reference#model-field-scalar-types
const PG_NATIVE = {
  Text: "text", VarChar: "varchar", Char: "char", Uuid: "uuid", Citext: "citext", Inet: "inet", Xml: "xml", Bit: "bit", VarBit: "varbit",
  Integer: "integer", SmallInt: "smallint", Oid: "oid", BigInt: "bigint",
  DoublePrecision: "double precision", Real: "real", Decimal: "numeric", Money: "money",
  Boolean: "boolean", Timestamp: "timestamp", Timestamptz: "timestamptz", Date: "date", Time: "time", Timetz: "timetz",
  Json: "json", JsonB: "jsonb", ByteA: "bytea",
};

function prismaBlocks(text, label, blocks) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let cur = null;
  let depth = 0;
  for (const raw of lines) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    if (!cur) {
      const m = /^(model|view|enum|type|datasource|generator)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/.exec(line);
      if (m) {
        cur = { kind: m[1], name: m[2], lines: [] };
        depth = 1;
        continue;
      }
      continue;
    }
    for (const ch of line.replace(/"(?:[^"\\]|\\.)*"/g, '""')) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth <= 0) {
      blocks.push(cur);
      cur = null;
      continue;
    }
    cur.lines.push(line);
  }
  if (cur) throw new Exit(2, `${label}: block ${cur.kind} ${cur.name} is not closed`);
}

// `text` is one schema, or a list of { label, text } for the files of a multi-file schema
// (prismaSchemaFolder): enums, models and the datasource may sit in different files. A model's `schema`
// is its @@schema, or null without one.
export function parsePrisma(text) {
  const files = Array.isArray(text) ? text : [{ label: "schema.prisma", text }];
  const blocks = [];
  let provider = null;
  for (const f of files) prismaBlocks(f.text, f.label, blocks);
  const enums = new Set(blocks.filter((b) => b.kind === "enum").map((b) => b.name));
  const composites = new Set(blocks.filter((b) => b.kind === "type").map((b) => b.name));
  const modelNames = new Set(blocks.filter((b) => b.kind === "model" || b.kind === "view").map((b) => b.name));
  const ds = blocks.find((b) => b.kind === "datasource");
  if (ds) {
    for (const l of ds.lines) {
      const m = /^provider\s*=\s*"([^"]+)"/.exec(l);
      if (m) provider = m[1];
    }
  }
  const models = [];
  for (const b of blocks.filter((x) => x.kind === "model" || x.kind === "view")) {
    let table = b.name;
    let schema = null;
    let ignored = false;
    const columns = [];
    for (const l of b.lines) {
      if (l.startsWith("@@")) {
        const mm = /^@@map\(\s*(?:name\s*:\s*)?"([^"]+)"/.exec(l);
        if (mm) table = mm[1];
        const sm = /^@@schema\(\s*(?:map\s*:\s*)?"([^"]+)"/.exec(l);
        if (sm) schema = sm[1];
        if (/^@@ignore\b/.test(l)) ignored = true;
        continue;
      }
      const fm = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*(?:\("(?:[^"\\]|\\.)*"\))?)(\[\])?(\?)?(.*)$/.exec(l);
      if (!fm) continue;
      const [, field, typeRaw, list, opt, rest] = fm;
      if (/(^|\s)@ignore\b/.test(rest)) continue;
      const type = typeRaw.replace(/\(.*$/, "");
      if (modelNames.has(type) || composites.has(type)) continue; // a relation or a composite, not a column
      const mapM = /(?:^|\s)@map\(\s*(?:name\s*:\s*)?"([^"]+)"/.exec(rest);
      const dbM = /(?:^|\s)@db\.([A-Za-z]+)(?:\(([^)]*)\))?/.exec(rest);
      columns.push({
        field,
        name: mapM ? mapM[1] : field,
        type,
        list: Boolean(list),
        optional: Boolean(opt),
        isEnum: enums.has(type),
        native: dbM ? { name: dbM[1], args: dbM[2] ?? null } : null,
      });
    }
    if (!ignored) models.push({ model: b.name, table, schema, columns });
  }
  return { provider, models };
}

const isPostgres = (provider) => provider === "postgresql" || provider === "postgres";

// A scalar list is a Postgres array: logical `array`, physical `<element>[]`. `element` holds the
// element's logical types, so a contract that says `logicalType: string, physicalType: text[]` (what
// `datacontract import sql` writes for a `TEXT[]` column) agrees with `String[]`.
function prismaColumnTypes(col, provider) {
  if (col.list) {
    const el = prismaColumnTypes({ ...col, list: false }, provider);
    return { logical: ["array"], physical: el.physical && isPostgres(provider) && !col.isEnum ? `${el.physical}[]` : null, element: el.logical };
  }
  if (col.isEnum) return { logical: ["string"], physical: null };
  if (col.type === "Unsupported") return { logical: null, physical: null };
  const s = PRISMA_SCALARS[col.type];
  if (!s) return { logical: null, physical: null };
  let physical = null;
  if (isPostgres(provider)) {
    if (col.native) {
      const base = PG_NATIVE[col.native.name];
      physical = base ? (col.native.args ? `${base}(${col.native.args})` : base) : null;
    } else physical = s.pg;
  }
  let logical = s.logical;
  if (col.native && physical) logical = logicalFromPhysical(physical) ?? logical;
  return { logical, physical };
}

// ---------------------------------------------------------------------------------------------------
// contract-schema: the contract's columns and types against the real schema.

// A contract object names its table as `physicalName` (or `name`), optionally schema-qualified
// (`billing.orders`). Without a qualifier, the schema is the one the contract's servers give, when they
// give exactly one (`datacontract test` queries `<server schema>.<name>`).
const unquote = (s) => s.replace(/^["`[]|["`\]]$/g, "");

function splitQualified(name) {
  const parts = name.split(".").map((x) => unquote(x.trim()));
  return parts.length > 1 ? { table: parts[parts.length - 1], schema: parts[parts.length - 2] } : { table: parts[0], schema: null };
}

function serverSchemas(contract) {
  const servers = Array.isArray(contract?.servers) ? contract.servers : contract?.servers && typeof contract.servers === "object" ? Object.values(contract.servers) : [];
  return [...new Set(servers.map((s) => s && typeof s === "object" && typeof s.schema === "string" ? s.schema.trim() : "").filter(Boolean))];
}

function contractObjects(contract, file) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) throw new Exit(1, `${file}: not a mapping`);
  if (!Array.isArray(contract.schema) || !contract.schema.length) throw new Exit(1, `${file}: has no schema objects to compare`);
  const fromServers = serverSchemas(contract);
  return contract.schema.map((o, i) => {
    if (!o || typeof o !== "object") throw new Exit(1, `${file}: schema[${i}] is not a mapping`);
    const name = (typeof o.physicalName === "string" && o.physicalName) || o.name;
    if (typeof name !== "string" || !name) throw new Exit(1, `${file}: schema[${i}] has no name`);
    const props = Array.isArray(o.properties) ? o.properties : [];
    if (!props.length) throw new Exit(1, `${file}: schema object ${name} lists no properties`);
    const q = splitQualified(name);
    return {
      label: o.name ?? name,
      name,
      table: q.table,
      // The qualifier wins; otherwise the servers' schema when there is exactly one.
      schema: q.schema ?? (fromServers.length === 1 ? fromServers[0] : null),
      qualified: q.schema !== null,
      properties: props.map((p, j) => {
        const col = p && ((typeof p.physicalName === "string" && p.physicalName) || p.name);
        if (typeof col !== "string" || !col) throw new Exit(1, `${file}: ${name}.properties[${j}] has no name`);
        return { name: col, logicalType: p.logicalType ?? null, physicalType: p.physicalType ?? null, required: p.required === true };
      }),
    };
  });
}

const isArrayPhysical = (t) => typeof t === "string" && (/\[\s*\d*\s*\]\s*$/.test(t) || /^\s*array\b/i.test(t));

// Compares one contract object with one source table: [{ name, logical: [..]|null, physical|null, nullable|null, element? }].
function compareColumns(where, obj, sourceCols, problems, notes) {
  const byName = new Map(sourceCols.map((c) => [c.name, c]));
  const lower = new Map(sourceCols.map((c) => [c.name.toLowerCase(), c]));
  for (const p of obj.properties) {
    const s = byName.get(p.name) ?? null;
    if (!s) {
      const hint = lower.get(p.name.toLowerCase());
      problems.push(`${where}.${p.name}: in the contract, not in the schema${hint ? ` (the schema has ${hint.name}; names are case-sensitive)` : ""}`);
      continue;
    }
    if (p.logicalType !== null) {
      // An array column may be described by its element type when the contract's physicalType is the
      // array type itself: `datacontract import sql` writes `TEXT[]` as logicalType string.
      const accepts = s.logical && s.element && isArrayPhysical(p.physicalType) ? [...s.logical, ...s.element] : s.logical;
      if (!ODCS_LOGICAL.includes(p.logicalType)) problems.push(`${where}.${p.name}: logicalType ${JSON.stringify(p.logicalType)} is not an ODCS logical type`);
      else if (!accepts) problems.push(`${where}.${p.name}: the schema type ${s.typeLabel ?? "(none)"} cannot be compared with logicalType ${p.logicalType}`);
      else if (!accepts.map(logicalClass).includes(logicalClass(p.logicalType))) problems.push(`${where}.${p.name}: contract logicalType ${p.logicalType}, schema type ${s.typeLabel} (${s.logical.join("/")})`);
    }
    if (p.physicalType !== null && s.physical !== null && !physicalAgrees(p.physicalType, s.physical)) {
      problems.push(`${where}.${p.name}: contract physicalType ${p.physicalType}, schema type ${s.physical}`);
    }
    if (p.physicalType !== null && s.physical === null) {
      if (s.logical === null) problems.push(`${where}.${p.name}: the schema declares no type; physicalType ${p.physicalType} cannot be checked`);
      else notes.push(`${where}.${p.name}: physicalType ${p.physicalType} not checked (the schema gives no physical type here; logicalType was)`);
    }
    if (p.required && s.nullable === true) problems.push(`${where}.${p.name}: the contract says required, the schema allows null`);
  }
  const listed = new Set(obj.properties.map((p) => p.name));
  const extra = sourceCols.filter((c) => !listed.has(c.name)).map((c) => c.name);
  if (extra.length) notes.push(`${where}: in the schema, not in the contract (not published, not a failure): ${extra.join(", ")}`);
}

// One file, or every *.prisma under a folder (Prisma's multi-file schema). The datasource must be among
// them: without its provider no physical type can be checked, and a green over that would be a lie.
function readPrismaFiles(p) {
  if (!fs.existsSync(p)) throw new Exit(2, `--prisma ${p}: no such file or folder`);
  const st = fs.statSync(p);
  if (st.isFile()) return [{ label: p, text: fs.readFileSync(p, "utf8") }];
  if (!st.isDirectory()) throw new Exit(2, `--prisma ${p}: not a file or folder`);
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && /\.prisma$/.test(e.name)) out.push({ label: f, text: fs.readFileSync(f, "utf8") });
    }
  };
  walk(p);
  if (!out.length) throw new Exit(2, `--prisma ${p}: no .prisma files under it`);
  return out;
}

function prismaSource(file) {
  const files = readPrismaFiles(file);
  const { provider, models } = parsePrisma(files);
  if (!models.length) throw new Exit(2, `--prisma ${file}: no models`);
  if (!provider) {
    throw new Exit(2, `--prisma ${file}: no datasource provider. For a multi-file schema pass its folder (for example prisma/schema), so the file holding the datasource is read too.`);
  }
  // A model without @@schema lives in the connection's schema, which is `public` on Postgres unless the
  // URL says otherwise; this script cannot see the URL, so it assumes `public` there.
  const defaultSchema = isPostgres(provider) ? "public" : null;
  return {
    label: file,
    warning: isPostgres(provider) ? null : `provider ${provider}: physical types are NOT CHECKED (only Postgres types are known); logical types and columns are`,
    find(obj) {
      const named = models.filter((m) => m.table === obj.table);
      if (!named.length) return null;
      let hits = named;
      if (obj.schema) {
        hits = named.filter((m) => (m.schema ?? defaultSchema) === obj.schema || (m.schema === null && defaultSchema === null));
        if (!hits.length) {
          return { error: `the contract puts it in schema ${obj.schema}; the Prisma schema has it in ${named.map((m) => m.schema ?? defaultSchema ?? "(the connection's schema)").join(", ")}` };
        }
      }
      if (hits.length > 1) return { ambiguous: hits.map((h) => `${h.model}${h.schema ? ` (@@schema ${h.schema})` : ""}`) };
      const m = hits[0];
      return {
        columns: m.columns.map((c) => {
          const t = prismaColumnTypes(c, provider);
          return {
            name: c.name,
            logical: t.logical,
            physical: t.physical,
            element: t.element ?? null,
            // Postgres has no NOT NULL on a scalar list Prisma creates; the column takes NULL.
            nullable: c.optional || c.list,
            typeLabel: `${c.type}${c.list ? "[]" : ""}${c.optional ? "?" : ""}${c.native ? ` @db.${c.native.name}${c.native.args ? `(${c.native.args})` : ""}` : ""}`,
          };
        }),
      };
    },
  };
}

// dbt: a contract names the relation the warehouse holds, which is the model's alias (dbt sets it to
// the model name, or `<name>_v<n>` for a version, when none is given). The model name alone is not a
// table, so it does not match. A schema-qualified contract name is compared with the node's schema too;
// an unqualified one is not, because CI often builds into a different schema than the contract's server.
function manifestSource(manifestFile, catalogFile) {
  const m = readJson(manifestFile, "--manifest");
  if (!m || typeof m.nodes !== "object" || m.nodes === null) throw new Exit(2, `--manifest ${manifestFile}: no nodes; is it a dbt manifest.json?`);
  const cat = catalogFile ? readJson(catalogFile, "--catalog") : null;
  if (cat && (typeof cat.nodes !== "object" || cat.nodes === null)) throw new Exit(2, `--catalog ${catalogFile}: no nodes; is it a dbt catalog.json?`);
  const project = m.metadata?.project_name;
  const models = Object.entries(m.nodes).filter(([, n]) => n?.resource_type === "model" && (!project || n.package_name === project));
  if (!models.length) throw new Exit(2, `--manifest ${manifestFile}: no models of project ${project ?? "(unknown)"}`);
  const relation = (n) => String(n.alias ?? n.name).toLowerCase();
  return {
    label: manifestFile,
    warning: null,
    find(obj) {
      const table = obj.table.toLowerCase();
      let hits = models.filter(([, n]) => relation(n) === table);
      if (!hits.length) {
        const byModel = models.filter(([, n]) => String(n.name).toLowerCase() === table);
        if (byModel.length) return { error: `no relation is named ${obj.table}; that is a model name, and the warehouse holds ${byModel.map(([, n]) => relation(n)).join(", ")}. Name the table (the alias) in the contract` };
        return null;
      }
      if (obj.qualified) {
        const want = obj.schema.toLowerCase();
        const inSchema = hits.filter(([, n]) => String(n.schema ?? "").toLowerCase() === want);
        if (!inSchema.length) return { error: `the contract puts it in schema ${obj.schema}; the manifest builds it in ${hits.map(([, n]) => n.schema).join(", ")}` };
        hits = inSchema;
      }
      if (hits.length > 1) return { ambiguous: hits.map(([id]) => id) };
      const [id, n] = hits[0];
      const catCols = cat?.nodes?.[id]?.columns;
      if (cat && !catCols) return { error: `${id} is not in the catalog (${catalogFile}); run dbt docs generate after building it` };
      const decl = Object.values(n.columns ?? {});
      let columns;
      if (catCols) {
        columns = Object.values(catCols).map((c) => ({ name: c.name, logical: logicalFromPhysical(c.type), physical: c.type ?? null, nullable: null, typeLabel: c.type }));
      } else {
        if (!decl.length) return { error: `${id} declares no columns in the manifest; declare them (with data_type) or pass --catalog target/catalog.json` };
        columns = decl.map((c) => ({ name: c.name, logical: c.data_type ? logicalFromPhysical(c.data_type) : null, physical: c.data_type ?? null, nullable: null, typeLabel: c.data_type ?? "(no data_type)" }));
      }
      // dbt does not say a column is nullable, so `required` is not checked against a manifest.
      return { columns };
    },
  };
}

// Warehouse identifiers fold case (Snowflake upper, BigQuery and Postgres-unquoted lower), so a
// manifest or catalog source compares column names case-insensitively. Prisma quotes, so it does not.
function foldCase(cols) {
  return cols.map((c) => ({ ...c, name: c.name.toLowerCase() }));
}

export function contractSchemaCheck(argv, env = process.env) {
  const f = parseFlags(argv, ["contract", "prisma", "manifest", "catalog"]);
  if (!f.contract) throw new Exit(2, "contract-schema: --contract <file> is required");
  if (Boolean(f.prisma) === Boolean(f.manifest)) throw new Exit(2, "contract-schema: give exactly one of --prisma <schema.prisma or folder> or --manifest <manifest.json>");
  if (f.catalog && !f.manifest) throw new Exit(2, "contract-schema: --catalog goes with --manifest");
  const contract = readStructured(f.contract, env);
  const objects = contractObjects(contract, f.contract);
  const source = f.prisma ? prismaSource(f.prisma) : manifestSource(f.manifest, f.catalog);
  const problems = [];
  const notes = [];
  let compared = 0;
  for (const obj of objects) {
    const hit = source.find(obj);
    if (!hit) {
      problems.push(`${obj.name}: the contract describes it, the schema (${source.label}) has no such table`);
      continue;
    }
    if (hit.ambiguous) {
      problems.push(`${obj.name}: matches more than one table (${hit.ambiguous.join(", ")}); qualify it with its schema in the contract`);
      continue;
    }
    if (hit.error) {
      problems.push(`${obj.name}: ${hit.error}`);
      continue;
    }
    let cols = hit.columns;
    let o = obj;
    if (f.manifest) {
      cols = foldCase(cols);
      o = { ...obj, properties: obj.properties.map((p) => ({ ...p, name: p.name.toLowerCase() })) };
    }
    compareColumns(obj.name, o, cols, problems, notes);
    compared += obj.properties.length;
  }
  const head = source.warning ? `WARNING: ${source.warning}\n` : "";
  const tail = notes.length ? `\n${notes.map((n) => `  note: ${n}`).join("\n")}` : "";
  if (problems.length) throw new Exit(1, `${head}contract-schema: ${f.contract} disagrees with ${source.label} (${problems.length})\n${problems.map((p) => `  ${p}`).join("\n")}${tail}`);
  return `${head}contract-schema: ${f.contract} agrees with ${source.label} (${compared} column(s))${tail}`;
}

// ---------------------------------------------------------------------------------------------------
// consumers: the consumers a contract lists, as tab-separated `repo<TAB>team` lines, or as a Markdown
// section for the breaking-change notice. Exit 1 when the list is malformed.

// Untrusted text (a path, an owner, a team) goes into the notice as a code span: GitHub renders no
// Markdown or HTML inside one, and a mention or bare URL there is neither notified nor linked. Line
// breaks, control characters and backticks are replaced first, so the span cannot be closed or broken.
export function mdCode(s) {
  const t = String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return `\`${t || "(empty)"}\``;
}

export function consumersCmd(argv, env = process.env) {
  const f = parseFlags(argv, ["contract", "format", "label"]);
  if (!f.contract) throw new Exit(2, "consumers: --contract <file> is required");
  const format = f.format ?? "lines";
  if (!["lines", "markdown"].includes(format)) throw new Exit(2, "consumers: --format is lines or markdown");
  const c = readStructured(f.contract, env);
  const { consumers, problems } = contractConsumers(c);
  if (format === "lines") {
    if (problems.length) throw new Exit(1, `consumers: ${f.contract}\n${problems.map((p) => `  ${p}`).join("\n")}`);
    return consumers.map((x) => `${x.repo}\t${x.team}`).join("\n");
  }
  const label = mdCode(f.label ?? f.contract);
  const owners = contractOwners(c);
  const out = [`#### ${label}`, ""];
  if (owners.length) out.push(`Owner: ${owners.map(mdCode).join(", ")}`, "");
  if (!consumers.length) out.push(`${label} lists no consumers, so nobody downstream can be told. Add them under \`customProperties\` → \`consumers\` (\`repo\`, \`team\`).`);
  for (const x of consumers) {
    const repo = x.repo ? `[${x.repo}](https://github.com/${x.repo})` : "";
    // A GitHub team reference (org/team, with or without @) is written as a mention, so the team is notified.
    const team = x.team ? (/^@?[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(x.team) ? `@${x.team.replace(/^@/, "")}` : mdCode(x.team)) : "";
    out.push(`- ${[repo, team].filter(Boolean).join(" · ")}`);
  }
  for (const p of problems) out.push(`- (could not read a consumer: ${mdCode(p)})`);
  return out.join("\n");
}

export function main(argv, env = process.env) {
  const [cmd, sub, ...rest] = argv;
  if (cmd === "version" || cmd === "--version") return VERSION;
  if (cmd === "evidence" && sub === "append") return evidenceAppend(rest, env);
  if (cmd === "owner") return ownerCheck(argv.slice(1), env);
  if (cmd === "contract-schema") return contractSchemaCheck(argv.slice(1), env);
  if (cmd === "consumers") return consumersCmd(argv.slice(1), env);
  throw new Exit(
    2,
    [
      "usage: governance-check.mjs <command>",
      "  version",
      "  evidence append --check <name> --result pass|fail|not_run [--run-link <url>] [--commit <sha>] [--detail <text>] [--file <path>]",
      "  owner (--contracts <dir> | --contract <file> ...) [--manifest <manifest.json>]",
      "  contract-schema --contract <file> (--prisma <schema.prisma or folder> | --manifest <manifest.json> [--catalog <catalog.json>])",
      "  consumers --contract <file> [--format lines|markdown] [--label <path>]",
    ].join("\n"),
  );
}

if (process.argv[1] && path.basename(process.argv[1]) === "governance-check.mjs") {
  try {
    const out = main(process.argv.slice(2));
    if (out) console.log(out);
  } catch (e) {
    if (e instanceof Exit) {
      console.error(`governance-check: ${e.message}`);
      process.exit(e.code);
    }
    console.error(`governance-check: ${e?.stack ?? e}`);
    process.exit(2);
  }
}
