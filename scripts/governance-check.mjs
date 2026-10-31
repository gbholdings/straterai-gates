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
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

export const VERSION = "1.4.0";
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
  const f = parseFlags(argv, ["check", "result", "run-link", "commit", "detail", "file", "date", "from"]);
  if (f.from) {
    if (Object.keys(f).some((k) => !["from", "file"].includes(k))) throw new Exit(2, "evidence append: --from takes only --file beside it");
    return evidenceFrom(f.from, f.file ?? env.GOVERNANCE_EVIDENCE_FILE ?? DEFAULT_EVIDENCE);
  }
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

// ---------------------------------------------------------------------------------------------------
// monitors: every run-time monitor reaches a person. Each Elementary test in a dbt manifest, and each GX
// checkpoint in a file data context, must name a deliverable alert destination and a real owner, and one
// repository must not configure both Elementary and GX. Every dbt project that uses Elementary and every GX
// context under --repo must be covered by an input, each manifest must be this repository's and newer than
// every project file, and each GX context must load in GX itself. Anything the check could not look at is
// NOT CHECKED (exit 2), never a pass.
//
// Elementary reads `channel`, `owner` and `alert_suppression_interval` from the test's meta over the model's,
// each at the top of meta or under `alerts_config` (elementary/monitor/fetchers/alerts/schema/alert_data.py
// at 54368c6381caa2d00569b4b49c512ff0a31e9457). dbt 1.10+ writes meta under `config.meta`; both are read.

const SKIP_DIRS = new Set([".git", "node_modules", "dbt_packages", "dbt_modules", "target", "logs", ".venv", "venv", "site-packages", "__pycache__", ".gates"]);
const REQ_FILE = /^(requirements[\w.-]*\.(txt|in)|constraints[\w.-]*\.txt|pyproject\.toml|Pipfile|setup\.cfg|setup\.py|environment\.ya?ml)$/i;
const DOCKER_FILE = /^(Dockerfile|Containerfile)([.-][\w.-]+)?$|\.(dockerfile|containerfile)$/i;
// Hours. Past a week, a monitor that fired once stays silent through a week of further failures.
export const MAX_SUPPRESSION_HOURS = 168;

// Text from the repository (paths, model and test names) printed into the Actions log. A newline in a name
// would start a new line, and a line that starts with `::` is a workflow command, so control characters are
// written as escapes and nothing interpolated can begin a line.
export const q = (v) => String(v).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

function repoFiles(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (e.isFile()) out.push(p);
    }
  };
  walk(root);
  return out;
}

const relTo = (root, f) => path.relative(root, f).split(path.sep).join("/") || ".";
// A dependency file: a requirements or constraints file wherever it sits (requirements/prod.txt too), a
// Python project file, or a container build file.
const isReqFile = (f, root) => {
  const base = path.basename(f);
  if (REQ_FILE.test(base) || DOCKER_FILE.test(base)) return true;
  return /\.(txt|in)$/i.test(base) && relTo(root, path.dirname(f)).split("/").some((s) => /^(requirements|constraints)$/i.test(s));
};

const dbtProjectName = (file) => /^name:\s*["']?([A-Za-z_][\w]*)["']?\s*(#.*)?$/m.exec(fs.readFileSync(file, "utf8"))?.[1] ?? null;
const usesElementary = (lines) => lines.some((l) => /elementary-data\/(elementary|dbt-data-reliability)\b/i.test(l));
const stripComments = (text) => text.split(/\r?\n/).map((l) => l.replace(/#.*$/, ""));

// What the repository configures: the tools, with the files that say so, every dbt project (and whether its
// packages pull in Elementary) and every GX file context. Comments are ignored.
export function detectMonitorTools(root) {
  const found = { elementary: [], gx: [], dbtProjects: [], gxContexts: [] };
  const files = repoFiles(root);
  for (const f of files) {
    const base = path.basename(f);
    const rel = relTo(root, f);
    if (base === "great_expectations.yml") {
      found.gx.push(rel);
      found.gxContexts.push({ dir: path.dirname(f), rel: relTo(root, path.dirname(f)) });
    }
    if (base === "dbt_project.yml") {
      const dir = path.dirname(f);
      const pk = ["packages.yml", "packages.yaml", "dependencies.yml", "dependencies.yaml"].map((n) => path.join(dir, n)).filter((p) => fs.existsSync(p));
      found.dbtProjects.push({ dir, rel: relTo(root, dir), name: dbtProjectName(f), elementary: pk.some((p) => usesElementary(stripComments(fs.readFileSync(p, "utf8")))) });
    }
    const isPackages = /^(packages|dependencies)\.ya?ml$/.test(base);
    const isReq = isReqFile(f, root);
    if (!isPackages && !isReq) continue;
    const lines = stripComments(fs.readFileSync(f, "utf8"));
    if (isPackages && usesElementary(lines)) found.elementary.push(rel);
    if (isReq) {
      // great_expectations, great-expectations, and anything that pulls it in by name, such as
      // apache-airflow-providers-great-expectations or `RUN pip install great_expectations`
      if (lines.some((l) => /great[-_]expectations\b/i.test(l))) found.gx.push(rel);
      if (lines.some((l) => /(^|[^\w/-])elementary-data\b/i.test(l))) found.elementary.push(rel);
    }
  }
  return found;
}

// A name a person can be reached at, or a list of them. Placeholders are not names: empty, a bare `#` or
// `@`, `<...>`, TODO, TBD, none, n/a, changeme, example, and the bare words owner and team.
const PLACEHOLDER = /^(todo|tbd|tba|fixme|xxx+|none|null|nil|n\/?a|na|changeme|change[-_ ]?me|replace[-_ ]?me|placeholder|owner|team|channel|someone|unknown|default|\?+|-+|_+)$/i;
export function isPlaceholder(s) {
  const t = String(s).trim();
  if (/^<.*>$/.test(t) || /example/i.test(t)) return true;
  const bare = t.replace(/^[#@]+/, "").trim();
  return bare === "" || PLACEHOLDER.test(bare) || /^(todo|tbd|fixme)\b/i.test(bare);
}
// The usable names in a value, and the placeholders found in it. Anything that is not a string or a list of
// strings (a number, an object, a list holding one) holds no name.
const names = (v) => {
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  if (!list.every((x) => typeof x === "string")) return { ok: [], bad: [] };
  const trimmed = list.map((x) => x.trim()).filter(Boolean);
  return { ok: trimmed.filter((x) => !isPlaceholder(x)), bad: trimmed.filter(isPlaceholder) };
};
const why = (n, what) => (n.bad.length ? `${what} is a placeholder (${n.bad.map((b) => JSON.stringify(q(b))).join(", ")})` : `no ${what}`);

// Elementary's view of a node's meta: config.meta over meta, then alerts_config flattened on top.
function elementaryMeta(node) {
  const m = { ...(node?.meta ?? {}), ...(node?.config?.meta ?? {}) };
  const ac = m.alerts_config && typeof m.alerts_config === "object" ? m.alerts_config : {};
  const flat = { ...m, ...ac };
  delete flat.alerts_config;
  return flat;
}

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const PROJECT_EXT = /\.(sql|ya?ml|csv|py|md|jinja2?)$/i;

// The files dbt reads for a project: its config files and everything under its resource paths
// (dbt_project.yml's model-paths, seed-paths and the rest, each defaulting to dbt's own folder name). A
// script, a README or a CI file beside the project is not an input, so editing one does not make the
// manifest stale.
const RESOURCE_PATHS = { "model-paths": ["models"], "seed-paths": ["seeds"], "test-paths": ["tests"], "analysis-paths": ["analyses"], "macro-paths": ["macros"], "snapshot-paths": ["snapshots"], "docs-paths": [] };
const DBT_CONFIG_FILES = ["dbt_project.yml", "packages.yml", "packages.yaml", "dependencies.yml", "dependencies.yaml", "selectors.yml"];
function dbtInputs(dir) {
  const text = fs.readFileSync(path.join(dir, "dbt_project.yml"), "utf8");
  const dirs = new Set();
  for (const [key, def] of Object.entries(RESOURCE_PATHS)) {
    const inline = new RegExp(`^${key}:[ \\t]*\\[([^\\]]*)\\]`, "m").exec(text);
    const block = new RegExp(`^${key}:[ \\t]*(?:#.*)?\\r?\\n((?:[ \\t]+-[^\\n]*\\r?\\n?)+)`, "m").exec(text);
    const list = inline ? inline[1].split(",") : block ? block[1].split(/\r?\n/).map((l) => l.replace(/^\s*-\s*/, "")) : def;
    for (const v of list.map((x) => x.replace(/#.*$/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean)) dirs.add(v);
  }
  const out = DBT_CONFIG_FILES.map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f));
  for (const d of dirs) {
    const p = path.resolve(dir, d);
    if (p.startsWith(path.resolve(dir)) && fs.existsSync(p) && fs.statSync(p).isDirectory()) out.push(...repoFiles(p));
  }
  return [...new Set(out)];
}

// Why a manifest is not a current parse of the dbt project at `proj.dir`, or [] when it is. dbt checksums a
// .sql file as sha256 of its stripped text; every .sql in the project is a node or a macro of the project's
// package; and no project file is newer than the manifest's generated_at (a schema.yml carries no checksum,
// so its mtime is what ties it).
function manifestStaleness(m, proj) {
  const pkg = m.metadata.project_name;
  const reasons = [];
  const listed = new Set();
  const own = [m.nodes, m.sources, m.macros, m.exposures, m.metrics, m.semantic_models, m.saved_queries, m.unit_tests]
    .flatMap((o) => Object.values(o ?? {}))
    .filter((n) => n?.package_name === pkg);
  for (const n of own) {
    const files = [n.original_file_path, typeof n.patch_path === "string" ? n.patch_path.replace(/^[\w-]+:\/\//, "") : null].filter((x) => typeof x === "string" && x);
    for (const rel of files) {
      listed.add(rel.split(path.sep).join("/"));
      const p = path.join(proj.dir, rel);
      if (!fs.existsSync(p)) {
        reasons.push(`${q(rel)} is in the manifest and not in ${q(proj.rel)}`);
        continue;
      }
      if (rel === n.original_file_path && /\.sql$/i.test(rel) && n.checksum?.name === "sha256" && sha256(fs.readFileSync(p, "utf8").trim()) !== n.checksum.checksum)
        reasons.push(`${q(rel)} has changed since the manifest was written`);
    }
  }
  const files = dbtInputs(proj.dir);
  for (const f of files) {
    const rel = relTo(proj.dir, f);
    if (/\.sql$/i.test(f) && !listed.has(rel)) reasons.push(`${q(rel)} is not in the manifest`);
  }
  const generated = Date.parse(m.metadata.generated_at ?? "");
  if (!Number.isFinite(generated)) reasons.push("the manifest has no metadata.generated_at");
  else {
    const newer = files.filter((f) => PROJECT_EXT.test(f) && fs.statSync(f).mtimeMs > generated + 1).map((f) => relTo(proj.dir, f));
    if (newer.length) reasons.push(`${newer.slice(0, 5).map(q).join(", ")}${newer.length > 5 ? ` and ${newer.length - 5} more` : ""} changed after the manifest was written (${q(m.metadata.generated_at)})`);
  }
  return [...new Set(reasons)];
}

function elementaryMonitors(manifestFile, tools, problems, counted, unchecked) {
  const m = readJson(manifestFile, "--manifest");
  const shown = q(manifestFile);
  if (!/\/manifest\/v\d+/.test(m?.metadata?.dbt_schema_version ?? "")) throw new Exit(2, `--manifest ${shown}: not a dbt manifest (no metadata.dbt_schema_version)`);
  const pkg = m.metadata.project_name;
  const candidates = tools.dbtProjects.filter((p) => p.name && p.name === pkg);
  if (!candidates.length) {
    unchecked.push(`${shown} is the manifest of dbt project ${q(pkg ?? "(unnamed)")}, and --repo holds no dbt project of that name`);
    return null;
  }
  const tried = candidates.map((p) => ({ p, reasons: manifestStaleness(m, p) }));
  const tied = tried.find((t) => !t.reasons.length);
  if (!tied) {
    for (const t of tried) unchecked.push(`${shown} is not a current parse of ${q(t.p.rel)} (run dbt parse): ${t.reasons.slice(0, 5).join("; ")}`);
    return null;
  }
  const nodes = m.nodes ?? {};
  const sources = m.sources ?? {};
  const tests = Object.entries(nodes).filter(([, n]) => n?.resource_type === "test" && n?.test_metadata?.namespace === "elementary");
  if (!tests.length) {
    unchecked.push(`${shown} holds no Elementary test, so there is nothing to check in ${q(tied.p.rel)}`);
    return tied.p;
  }
  for (const [id, t] of tests) {
    const parentId = t.attached_node ?? (t.depends_on?.nodes ?? []).find((x) => /^(model|source|seed|snapshot)\./.test(x));
    const parent = parentId ? (nodes[parentId] ?? sources[parentId]) : undefined;
    const tm = elementaryMeta(t);
    const pm = elementaryMeta(parent);
    const on = q(parent?.name ?? "(no model)");
    const where = `${q(id)} (elementary.${q(t.test_metadata.name)} on ${on})`;
    counted.push(where);
    // the test's value wins, as in Elementary; an empty one on the test does not fall back to the model's
    const pick = (k) => (k in tm ? tm[k] : pm[k]);
    const channel = names(pick("channel"));
    const owner = names(pick("owner"));
    if (!channel.ok.length) problems.push(`${where}: ${why(channel, "alert destination")} (set meta.channel on the test or on ${on})`);
    if (!owner.ok.length) problems.push(`${where}: ${why(owner, "owner")} (set meta.owner on ${on}; a monitor's owner is its dataset's)`);
    const supp = pick("alert_suppression_interval");
    if (supp !== undefined && supp !== null) {
      const h = typeof supp === "number" ? supp : typeof supp === "string" && supp.trim() !== "" ? Number(supp) : NaN;
      if (!Number.isFinite(h) || h < 0) problems.push(`${where}: alert_suppression_interval ${JSON.stringify(q(JSON.stringify(supp)))} is not a number of hours`);
      else if (h > MAX_SUPPRESSION_HOURS) problems.push(`${where}: alert_suppression_interval ${h} hours silences the monitor for longer than ${MAX_SUPPRESSION_HOURS} after it fires`);
    }
  }
  return tied.p;
}

// GX Core 1.x actions that send a notification, and the field sets that make one deliverable: each inner
// list must be fully set. Slack takes a webhook, or a token with a channel; email takes the server, the port
// and the receivers.
const GX_ROUTES = {
  slack: [["slack_webhook"], ["slack_token", "slack_channel"]],
  microsoft: [["teams_webhook"]],
  email: [["smtp_address", "smtp_port", "receiver_emails"]],
  opsgenie: [["api_key"]],
  api: [["url"]],
};
const isSet = (v) => (typeof v === "number" ? Number.isFinite(v) : names(v).ok.length > 0);

function jsonFiles(dir) {
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
}

// Loads the context and each checkpoint with GX itself, in a separate isolated Python, from a temp
// directory. Prints {"error": <str|null>, "checkpoints": {<name>: <error|null>}}.
const GX_LOAD = `
import json, os, sys
os.environ["GX_ANALYTICS_ENABLED"] = "false"
out = {"error": None, "checkpoints": {}}
try:
    import great_expectations as gx
    ctx = gx.get_context(mode="file", context_root_dir=sys.argv[1])
except Exception as e:
    out["error"] = (type(e).__name__ + ": " + str(e))[:400]
else:
    for name in sys.argv[2:]:
        try:
            ctx.checkpoints.get(name)
            out["checkpoints"][name] = None
        except Exception as e:
            out["checkpoints"][name] = (type(e).__name__ + ": " + str(e))[:400]
print("GATES-GX-LOAD " + json.dumps(out))
`;

function gxLoad(python, gxDir, cpNames) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gates-gx-"));
  try {
    const env = { ...process.env, GX_ANALYTICS_ENABLED: "false" };
    delete env.BASH_ENV;
    delete env.ENV;
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    const r = spawnSync(python, ["-I", "-c", GX_LOAD, path.resolve(gxDir), ...cpNames], { cwd, env, encoding: "utf8", timeout: 120000 });
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("GATES-GX-LOAD "));
    if (!line) return { fatal: `${q(python)} could not run GX (exit ${r.status ?? r.signal ?? r.error?.code}): ${q((r.stderr ?? "").trim().split("\n").slice(-1)[0] ?? "")}` };
    return JSON.parse(line.slice("GATES-GX-LOAD ".length));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function gxMonitors(gxDir, python, problems, counted, unchecked) {
  if (!fs.existsSync(gxDir) || !fs.statSync(gxDir).isDirectory()) throw new Exit(2, `--gx ${q(gxDir)}: no such directory`);
  const cpDir = path.join(gxDir, "checkpoints");
  const files = jsonFiles(cpDir);
  if (!files.length) {
    unchecked.push(`${q(cpDir)} holds no checkpoint (*.json), so there is nothing to check`);
    return;
  }
  const index = (sub) => new Map(jsonFiles(path.join(gxDir, sub)).map((f) => readJson(path.join(gxDir, sub, f), sub)).map((j) => [j?.name, j]));
  const vds = index("validation_definitions");
  const suites = index("expectations");
  const cps = files.map((f) => ({ f, cp: readJson(path.join(cpDir, f), "checkpoint") }));
  for (const { f, cp } of cps) {
    const where = `checkpoint ${q(cp?.name ?? f)}`;
    counted.push(where);
    const actions = (Array.isArray(cp?.actions) ? cp.actions : []).filter((a) => GX_ROUTES[a?.type] && (a.notify_on ?? "all") !== "success");
    const deliverable = actions.filter((a) => GX_ROUTES[a.type].some((set) => set.every((k) => isSet(a[k]))));
    if (!deliverable.length) {
      const partial = actions.map((a) => `${q(a.type)} needs ${GX_ROUTES[a.type].map((s) => s.join(" + ")).join(" or ")}`);
      problems.push(`${where}: no deliverable alert destination (${partial.length ? partial.join("; ") : `an action of type ${Object.keys(GX_ROUTES).join(", ")} with notify_on all or failure`})`);
    }
    for (const a of deliverable) {
      for (const k of ["slack_channel", "receiver_emails"]) if (a[k] !== undefined && names(a[k]).bad.length) problems.push(`${where}: ${q(a.type)} ${k} is a placeholder`);
    }
    const refs = Array.isArray(cp?.validation_definitions) ? cp.validation_definitions : [];
    if (!refs.length) problems.push(`${where}: validates nothing (no validation_definitions)`);
    for (const ref of refs) {
      const vd = vds.get(ref?.name);
      const suite = vd && suites.get(vd?.suite?.name);
      if (!vd) problems.push(`${where}: validation definition ${q(ref?.name ?? "(unnamed)")} is not in ${q(path.join(gxDir, "validation_definitions"))}`);
      else if (!suite) problems.push(`${where}: suite ${q(vd?.suite?.name ?? "(unnamed)")} is not in ${q(path.join(gxDir, "expectations"))}`);
      else {
        const owner = names(suite?.meta?.owner);
        if (!owner.ok.length) problems.push(`${where}: suite ${q(suite.name)} ${owner.bad.length ? "owner is a placeholder" : "has no owner"} (set meta.owner on the suite to its dataset's owner)`);
      }
    }
  }
  if (!python) {
    unchecked.push(`GX context ${q(gxDir)} was not loaded in GX (pass --gx-python <python with great_expectations>, or set GATES_GX_PYTHON)`);
    return;
  }
  const loaded = gxLoad(python, gxDir, cps.map(({ f, cp }) => cp?.name ?? f.replace(/\.json$/, "")));
  if (loaded.fatal) unchecked.push(`GX context ${q(gxDir)}: ${loaded.fatal}`);
  else if (loaded.error) problems.push(`GX context ${q(gxDir)}: GX refuses to load it: ${q(loaded.error)}`);
  else for (const [n, err] of Object.entries(loaded.checkpoints ?? {})) if (err) problems.push(`checkpoint ${q(n)}: GX refuses to load it: ${q(err)}`);
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

export function monitorsCheck(argv, env = process.env) {
  const f = parseFlags(argv, ["repo", "manifest", "gx", "gx-python"], ["manifest", "gx"]);
  const repo = f.repo ?? ".";
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) throw new Exit(2, `--repo ${q(repo)}: no such directory`);
  const manifests = f.manifest ?? [];
  const gxDirs = f.gx ?? [];
  const tools = detectMonitorTools(repo);
  const both = (w) => new Exit(1, `monitors: ${w}; use Elementary in a dbt repo and GX elsewhere, never both`);
  if (tools.elementary.length && tools.gx.length) throw both(`${q(repo)} configures both Elementary (${tools.elementary.map(q).join(", ")}) and GX (${tools.gx.map(q).join(", ")})`);
  if (manifests.length && gxDirs.length) throw both("both --manifest (Elementary) and --gx (GX) were given");
  if (manifests.length && tools.gx.length) throw both(`--manifest checks Elementary, and ${q(repo)} configures GX (${tools.gx.map(q).join(", ")})`);
  if (gxDirs.length && tools.elementary.length) throw both(`--gx checks GX, and ${q(repo)} configures Elementary (${tools.elementary.map(q).join(", ")})`);
  if (!manifests.length && !gxDirs.length) {
    const which = tools.elementary.length
      ? "Elementary is configured; pass --manifest target/manifest.json"
      : tools.gx.length
        ? "GX is configured; pass --gx <the gx directory>"
        : `neither Elementary nor GX is configured in ${q(repo)}`;
    throw new Exit(2, `monitors is NOT CHECKED: ${which}`);
  }
  const problems = [];
  const counted = [];
  const unchecked = [];
  if (manifests.length) {
    const covered = new Set();
    for (const m of manifests) {
      const p = elementaryMonitors(m, tools, problems, counted, unchecked);
      if (p) covered.add(real(p.dir));
    }
    for (const p of tools.dbtProjects) if (p.elementary && !covered.has(real(p.dir))) unchecked.push(`dbt project ${q(p.rel)} uses Elementary and no --manifest covers it`);
  } else {
    const python = f["gx-python"] ?? env.GATES_GX_PYTHON ?? "";
    const contexts = new Set(tools.gxContexts.map((c) => real(c.dir)));
    const given = new Set();
    for (const d of gxDirs) {
      if (!contexts.has(real(d))) {
        if (!fs.existsSync(d)) throw new Exit(2, `--gx ${q(d)}: no such directory`);
        unchecked.push(`--gx ${q(d)} is not a GX context under --repo ${q(repo)} (no great_expectations.yml there)`);
        continue;
      }
      given.add(real(d));
      gxMonitors(d, python, problems, counted, unchecked);
    }
    for (const c of tools.gxContexts) if (!given.has(real(c.dir))) unchecked.push(`GX context ${q(c.rel)} is not covered by a --gx`);
  }
  const tool = manifests.length ? "Elementary" : "GX";
  const lines = (xs) => xs.map((p) => `  ${p}`).join("\n");
  const notChecked = unchecked.length ? `\nNOT CHECKED:\n${lines(unchecked)}` : "";
  if (problems.length) throw new Exit(1, `monitors: ${problems.length} problem(s) in ${counted.length} ${tool} monitor(s)\n${lines(problems)}${notChecked}`);
  if (unchecked.length) throw new Exit(2, `monitors is NOT CHECKED: ${unchecked.length} input(s) could not be checked (${counted.length} ${tool} monitor(s) were)${notChecked}`);
  return `monitors: ${counted.length} ${tool} monitor(s), each with an alert destination and an owner`;
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

// `///` doc comments are kept per line: the ones above a field and one trailing it on the same line
// (classification reads `/// @classification(<tier>)` from them). A `//` comment is dropped.
function prismaBlocks(text, label, blocks) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let cur = null;
  let depth = 0;
  let pending = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith("///")) {
      pending.push(t.slice(3));
      continue;
    }
    const code = stripComment(raw);
    const line = code.trim();
    if (!line) continue;
    const after = raw.slice(code.length).trim();
    const trailing = after.startsWith("///") ? [after.slice(3)] : [];
    if (!cur) {
      pending = [];
      const m = /^(model|view|enum|type|datasource|generator)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/.exec(line);
      if (m) {
        cur = { kind: m[1], name: m[2], lines: [], docs: [] };
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
      pending = [];
      continue;
    }
    cur.lines.push(line);
    cur.docs.push([...pending, ...trailing]);
    pending = [];
  }
  if (cur) throw new Exit(2, `${label}: block ${cur.kind} ${cur.name} is not closed`);
}

// `text` is one schema, or a list of { label, text } for the files of a multi-file schema
// (prismaSchemaFolder): enums, models and the datasource may sit in different files. A model's `schema`
// is its @@schema, or null without one. With `{ all: true }`, @ignore fields and @@ignore models are kept
// (marked `ignored`): Prisma's client skips them, but their columns still hold data.
export function parsePrisma(text, opts = {}) {
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
    for (const [i, l] of b.lines.entries()) {
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
      const fieldIgnored = /(^|\s)@ignore\b/.test(rest);
      if (fieldIgnored && !opts.all) continue;
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
        unsupported: type === "Unsupported" ? (/^Unsupported\("((?:[^"\\]|\\.)*)"\)/.exec(typeRaw)?.[1] ?? "") : null,
        docs: b.docs[i] ?? [],
        ...(opts.all ? { ignored: fieldIgnored } : {}),
      });
    }
    if (!ignored) models.push({ model: b.name, table, schema, columns });
    else if (opts.all) models.push({ model: b.name, table, schema, columns, ignored: true });
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

// ---------------------------------------------------------------------------------------------------
// Classification, deletion map, retention and exports (data-privacy). The tiers are the repository's own,
// in governance/tiers.json; nothing here defines one. The file is required by every subcommand that
// reads a tag, and a missing or malformed one exits 2:
//
//   { "tiers": { "<name>": { "personal_data": true|false,
//                            "model": "allow|mask|deny", "embedding": "...", "log": "...", "export": "...",
//                            "retention_days": <days, optional>,
//                            "bigquery_policy_tag": "projects/<p>/locations/<l>/taxonomies/<t>/policyTags/<id>" | null } } }
//
// `personal_data` says the tier holds data about a person, so its tables go on the deletion map.
// `model`, `embedding`, `log` and `export` say whether a column of the tier may go there as it is (allow),
// only masked (mask), or not at all (deny).

const TIER_NAME = /^[a-z][a-z0-9_-]{0,62}$/;
const USES = ["model", "embedding", "log", "export"];
const USE_RULES = ["allow", "mask", "deny"];
const POLICY_TAG = /^projects\/[^/\s]+\/locations\/[^/\s]+\/taxonomies\/[^/\s]+\/policyTags\/[^/\s]+$/;
const DEFAULT_TIERS = "governance/tiers.json";

export function readTiers(file = DEFAULT_TIERS) {
  if (!fs.existsSync(file)) {
    throw new Exit(2, `tiers ${file}: no such file. Create it in this repository (format: the README, "Classification"); the tiers are the repository's own and no default applies.`);
  }
  const j = readJson(file, "tiers");
  if (!j || typeof j !== "object" || !j.tiers || typeof j.tiers !== "object" || Array.isArray(j.tiers)) {
    throw new Exit(2, `tiers ${file}: want { "tiers": { "<name>": { rules } } }`);
  }
  const names = Object.keys(j.tiers);
  if (!names.length) throw new Exit(2, `tiers ${file}: no tiers`);
  const allowed = ["personal_data", ...USES, "retention_days", "bigquery_policy_tag"];
  for (const n of names) {
    const r = j.tiers[n];
    if (!TIER_NAME.test(n)) throw new Exit(2, `tiers ${file}: tier name ${JSON.stringify(n)} must match ${TIER_NAME}`);
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new Exit(2, `tiers ${file}: ${n}: rules must be an object`);
    for (const k of Object.keys(r)) if (!allowed.includes(k)) throw new Exit(2, `tiers ${file}: ${n}: unknown key ${k} (known: ${allowed.join(", ")})`);
    if (typeof r.personal_data !== "boolean") throw new Exit(2, `tiers ${file}: ${n}: personal_data must be true or false`);
    for (const u of USES) if (!USE_RULES.includes(r[u])) throw new Exit(2, `tiers ${file}: ${n}: ${u} must be one of ${USE_RULES.join(", ")}`);
    if ("retention_days" in r && !(Number.isInteger(r.retention_days) && r.retention_days > 0)) throw new Exit(2, `tiers ${file}: ${n}: retention_days must be a whole number of days above 0`);
    if ("bigquery_policy_tag" in r && r.bigquery_policy_tag !== null && !(typeof r.bigquery_policy_tag === "string" && POLICY_TAG.test(r.bigquery_policy_tag))) {
      throw new Exit(2, `tiers ${file}: ${n}: bigquery_policy_tag must be a policy tag resource name (projects/.../policyTags/<id>) or null`);
    }
  }
  return j.tiers;
}

// `@classification(<tier>)` in a field's doc comments. Returns { tier, problem }.
const TAG_RE = /@classification\b(\(\s*([^()\s]*)\s*\))?/g;
export function docTier(docs) {
  const found = [];
  for (const d of docs) {
    for (const m of d.matchAll(TAG_RE)) {
      if (!m[1] || !TIER_NAME.test(m[2])) return { tier: null, problem: `malformed tag ${JSON.stringify(m[0].slice(0, 60))}; write /// @classification(<tier>)` };
      found.push(m[2]);
    }
  }
  const distinct = [...new Set(found)];
  if (distinct.length > 1) return { tier: null, problem: `two classifications (${distinct.join(", ")}); keep one` };
  return { tier: distinct[0] ?? null, problem: null };
}

const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

function git(args, opts = {}) {
  return spawnSync("git", ["-c", "core.attributesFile=/dev/null", "-c", "core.quotePath=false", ...args], { encoding: opts.encoding ?? "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// The fields (`Model.field`) of the schema at the base commit. A schema path that does not exist there
// (a new schema) has no fields, so every field is new. A base that cannot be resolved exits 2: a shallow
// checkout must not make every field look old, or new.
function prismaFieldsAtBase(schemaPath, base) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/@{}^~-]*$/.test(base)) throw new Exit(2, `--base ${base}: not a revision name`);
  const rev = git(["rev-parse", "-q", "--verify", "--end-of-options", `${base}^{commit}`]);
  if (rev.status !== 0) throw new Exit(2, `--base ${base}: cannot resolve it to a commit. In CI, check out with fetch-depth: 0 (or fetch the base branch) so origin/<base> exists.`);
  const commit = rev.stdout.trim();
  const rel = `./${path.relative(process.cwd(), path.resolve(schemaPath)).split(path.sep).join("/")}`;
  if (rel.startsWith("./../")) throw new Exit(2, `--schema ${schemaPath}: outside the working directory, so it cannot be read from --base`);
  const ls = git(["ls-tree", "-r", "-z", "--name-only", commit, "--", rel]);
  if (ls.status !== 0) throw new Exit(2, `--base ${base}: git ls-tree failed: ${ls.stderr.trim()}`);
  const files = ls.stdout.split("\0").filter((p) => p && /\.prisma$/.test(p));
  const texts = [];
  for (const p of files) {
    const b = git(["cat-file", "blob", `${commit}:./${p}`]);
    if (b.status !== 0) throw new Exit(2, `--base ${base}: cannot read ${p}: ${b.stderr.trim()}`);
    texts.push({ label: `${base}:${p}`, text: b.stdout });
  }
  const fields = new Set();
  if (texts.length) for (const m of parsePrisma(texts, { all: true }).models) for (const c of m.columns) fields.add(`${m.model}.${c.field}`);
  return { commit, fields, present: texts.length > 0 };
}

function classifyPrisma(schemaPath, tiers) {
  const files = readPrismaFiles(schemaPath);
  const parsed = parsePrisma(files, { all: true });
  if (!parsed.models.length) throw new Exit(2, `--schema ${schemaPath}: no models`);
  const fields = [];
  for (const m of parsed.models) {
    for (const c of m.columns) {
      const { tier, problem } = docTier(c.docs);
      fields.push({ model: m, col: c, key: `${m.model}.${c.field}`, tier, problem, known: tier ? Object.hasOwn(tiers, tier) : null });
    }
  }
  return { parsed, fields };
}

export function classificationPrisma(argv, env = process.env) {
  const f = parseFlags(argv, ["schema", "base", "tiers", "emit-comments", "date"]);
  const schemaPath = f.schema ?? "prisma/schema.prisma";
  const tiers = readTiers(f.tiers);
  const { parsed, fields } = classifyPrisma(schemaPath, tiers);
  const base = f.base ? prismaFieldsAtBase(schemaPath, f.base) : null;
  const problems = [];
  const warnings = [];
  let tagged = 0;
  for (const x of fields) {
    const where = `${x.key}${x.col.ignored ? " (@ignore)" : ""}`;
    if (x.problem) problems.push(`${where}: ${x.problem}`);
    else if (x.tier && !x.known) problems.push(`${where}: tier ${x.tier} is not in the tiers file (${Object.keys(tiers).join(", ")})`);
    else if (x.tier) tagged++;
    else if (!base || !base.fields.has(x.key)) problems.push(`${where}: new field with no /// @classification(<tier>)`);
    else warnings.push(`${where}: no classification (it is on the base branch too; tag it)`);
  }
  const out = [];
  if (!base) out.push("no --base: every field is treated as new and must be tagged");
  else if (!base.present) out.push(`${schemaPath} is not on ${f.base}: every field is new`);
  for (const w of warnings) out.push(`WARNING ${w}`);
  if (problems.length) throw new Exit(1, [`classification prisma: ${problems.length} field(s) fail`, ...problems.map((p) => `  ${p}`), ...out].join("\n"));
  out.push(`classification prisma: ${tagged} of ${fields.length} fields tagged with a known tier; ${warnings.length} older field(s) untagged`);
  if (f["emit-comments"]) out.push(emitComments(f["emit-comments"], parsed, fields, f.date));
  return out.join("\n");
}

// The classification comments earlier migrations set, in migration order: Prisma names each migration
// folder <timestamp>_<name>, so their sort order is the order they apply in.
const COMMENT_RE = /COMMENT ON COLUMN\s+((?:"(?:[^"]|"")+"\.)?"(?:[^"]|"")+")\."((?:[^"]|"")+)"\s+IS\s+(NULL|'classification:([a-z][a-z0-9_-]*)')\s*;/gi;
function emittedComments(dir) {
  const last = new Map();
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name).sort()) {
    const sql = path.join(dir, e, "migration.sql");
    if (!fs.existsSync(sql)) continue;
    for (const m of fs.readFileSync(sql, "utf8").matchAll(COMMENT_RE)) last.set(`${m[1]}.${quoteIdent(m[2].replace(/""/g, '"'))}`, m[4] ?? null);
  }
  return last;
}

function emitComments(dir, parsed, fields, date) {
  if (!isPostgres(parsed.provider)) throw new Exit(2, `--emit-comments: the datasource is ${parsed.provider ?? "unknown"}; COMMENT ON COLUMN is Postgres`);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Exit(2, `--emit-comments ${dir}: not a migrations folder`);
  const stamp = (date ?? new Date().toISOString()).replace(/[^0-9]/g, "").slice(0, 14);
  if (stamp.length !== 14) throw new Exit(2, `--date ${date}: want an ISO 8601 date and time`);
  const last = emittedComments(dir);
  const want = new Map();
  for (const x of fields) {
    const table = x.model.schema ? `${quoteIdent(x.model.schema)}.${quoteIdent(x.model.table)}` : quoteIdent(x.model.table);
    want.set(`${table}.${quoteIdent(x.col.name)}`, x.tier);
  }
  const lines = [];
  for (const [k, tier] of want) {
    const prev = last.has(k) ? last.get(k) : undefined;
    if (tier && prev !== tier) lines.push(`COMMENT ON COLUMN ${k} IS 'classification:${tier}';`);
    else if (!tier && prev) lines.push(`COMMENT ON COLUMN ${k} IS NULL;`);
  }
  if (!lines.length) return "emit-comments: every column's comment already matches its tag; no migration written";
  const folder = path.join(dir, `${stamp}_classification_comments`);
  if (fs.existsSync(folder)) throw new Exit(2, `--emit-comments: ${folder} exists already`);
  fs.mkdirSync(folder);
  const body = ["-- Generated by governance-check classification prisma --emit-comments from the /// @classification tags.", "-- Do not edit by hand: change the tag and generate again.", ...lines, ""].join("\n");
  fs.writeFileSync(path.join(folder, "migration.sql"), body);
  return `emit-comments: wrote ${path.join(folder, "migration.sql")} (${lines.length} statement(s))`;
}

// dbt: the project's models, optionally under some paths (original_file_path prefixes).
function dbtModels(manifestFile, prefixes) {
  const m = readJson(manifestFile, "--manifest");
  if (!m || typeof m.nodes !== "object" || m.nodes === null) throw new Exit(2, `--manifest ${manifestFile}: no nodes; is it a dbt manifest.json?`);
  const project = m.metadata?.project_name;
  let models = Object.entries(m.nodes).filter(([, n]) => n?.resource_type === "model" && (!project || n.package_name === project));
  if (!models.length) throw new Exit(2, `--manifest ${manifestFile}: no models of project ${project ?? "(unknown)"}`);
  for (const p of prefixes ?? []) {
    if (!models.some(([, n]) => String(n.original_file_path ?? "").startsWith(p))) throw new Exit(2, `--path ${p}: no model of the project is under it`);
  }
  if (prefixes?.length) models = models.filter(([, n]) => prefixes.some((p) => String(n.original_file_path ?? "").startsWith(p)));
  return models;
}

const dbtColumnTier = (c) => {
  const v = c?.config?.meta?.classification ?? c?.meta?.classification;
  return v === undefined || v === null ? null : String(v);
};

export function classificationDbt(argv, env = process.env) {
  const f = parseFlags(argv, ["manifest", "catalog", "tiers", "path"], ["path"]);
  if (!f.manifest) throw new Exit(2, "classification dbt: --manifest target/manifest.json is required");
  const tiers = readTiers(f.tiers);
  const models = dbtModels(f.manifest, f.path);
  const cat = f.catalog ? readJson(f.catalog, "--catalog") : null;
  if (cat && (typeof cat.nodes !== "object" || cat.nodes === null)) throw new Exit(2, `--catalog ${f.catalog}: no nodes; is it a dbt catalog.json?`);
  const problems = [];
  let cols = 0;
  for (const [id, n] of models) {
    const decl = Object.values(n.columns ?? {});
    const byName = new Map(decl.map((c) => [String(c.name).toLowerCase(), c]));
    if (cat) {
      const cc = cat.nodes[id]?.columns;
      if (!cc) problems.push(`${id}: not in the catalog; run dbt docs generate after building it`);
      for (const c of Object.values(cc ?? {})) if (!byName.has(String(c.name).toLowerCase())) problems.push(`${id}.${c.name}: in the warehouse, not declared in the YAML, so it carries no classification`);
    }
    if (!decl.length && !cat) problems.push(`${id}: declares no columns, so none is classified; declare them with meta.classification (pass --catalog to compare with the warehouse)`);
    for (const c of decl) {
      cols++;
      const t = dbtColumnTier(c);
      if (!t) problems.push(`${id}.${c.name}: no meta.classification`);
      else if (!Object.hasOwn(tiers, t)) problems.push(`${id}.${c.name}: tier ${t} is not in the tiers file (${Object.keys(tiers).join(", ")})`);
    }
  }
  if (problems.length) throw new Exit(1, [`classification dbt: ${problems.length} problem(s)`, ...problems.map((p) => `  ${p}`)].join("\n"));
  return `classification dbt: ${cols} column(s) in ${models.length} model(s), each with a known tier${cat ? "; every warehouse column is declared" : "; columns the YAML does not declare are NOT CHECKED (pass --catalog)"}`;
}

function oneModel(models, want) {
  const hits = models.filter(([id, n]) => id === want || n.name === want);
  if (!hits.length) throw new Exit(2, `--model ${want}: no such model in the project`);
  if (hits.length > 1) throw new Exit(2, `--model ${want}: ambiguous (${hits.map(([id]) => id).join(", ")}); give the unique_id`);
  return hits[0];
}

const SF_IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const sfIdent = (s) => (SF_IDENT.test(s) ? s : quoteIdent(s));
const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Generated, never set by hand: BigQuery policy tags as the full table schema `bq update` takes, and
// Snowflake tags as ALTER statements. Both are writes; apply them through the target guard.
export function classificationEmit(argv, env = process.env) {
  const [engine, ...rest] = argv;
  if (engine === "bigquery") {
    const f = parseFlags(rest, ["manifest", "tiers", "model", "current-schema"]);
    if (!f.manifest || !f.model) throw new Exit(2, "classification emit bigquery: --manifest and --model are required");
    if (!f["current-schema"]) throw new Exit(2, "classification emit bigquery: --current-schema <file> is required (bq show --schema --format=prettyjson <project>:<dataset>.<table>); bq update replaces the whole schema, so it starts from the current one");
    const tiers = readTiers(f.tiers);
    const [id, n] = oneModel(dbtModels(f.manifest), f.model);
    const current = readJson(f["current-schema"], "--current-schema");
    const fieldsIn = Array.isArray(current) ? current : current?.fields;
    if (!Array.isArray(fieldsIn) || fieldsIn.some((x) => !x || typeof x.name !== "string")) throw new Exit(2, `--current-schema ${f["current-schema"]}: want the JSON array bq show --schema prints`);
    const decl = new Map(Object.values(n.columns ?? {}).map((c) => [String(c.name).toLowerCase(), c]));
    const problems = [];
    const out = fieldsIn.map((field) => {
      const c = decl.get(field.name.toLowerCase());
      const t = c ? dbtColumnTier(c) : null;
      if (!c || !t) {
        problems.push(`${id}.${field.name}: no meta.classification`);
        return field;
      }
      if (!Object.hasOwn(tiers, t)) {
        problems.push(`${id}.${field.name}: tier ${t} is not in the tiers file`);
        return field;
      }
      if (!("bigquery_policy_tag" in tiers[t])) {
        problems.push(`tier ${t}: no bigquery_policy_tag in the tiers file; set a policy tag resource name, or null for none`);
        return field;
      }
      const next = { ...field };
      const tag = tiers[t].bigquery_policy_tag;
      // An empty list clears a tag set earlier: the tags in the repository are the whole truth.
      next.policyTags = { names: tag ? [tag] : [] };
      return next;
    });
    for (const [k, c] of decl) if (!fieldsIn.some((x) => x.name.toLowerCase() === k)) problems.push(`${id}.${c.name}: declared in dbt, not in the current BigQuery schema`);
    if (problems.length) throw new Exit(1, [`classification emit bigquery: ${problems.length} problem(s); nothing emitted`, ...[...new Set(problems)].map((p) => `  ${p}`)].join("\n"));
    return JSON.stringify(out, null, 2);
  }
  if (engine === "snowflake") {
    const f = parseFlags(rest, ["manifest", "tiers", "tag", "model", "path"], ["model", "path"]);
    if (!f.manifest || !f.tag) throw new Exit(2, "classification emit snowflake: --manifest and --tag <database.schema.tag> are required");
    if (!/^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*){0,2}$/.test(f.tag)) throw new Exit(2, `--tag ${f.tag}: want an unquoted [database.][schema.]name`);
    const tiers = readTiers(f.tiers);
    let models = dbtModels(f.manifest, f.path);
    if (f.model) models = f.model.map((m) => oneModel(models, m));
    const problems = [];
    const lines = [
      "-- Generated by governance-check classification emit snowflake from the dbt meta.classification tags.",
      "-- DDL: run it through db-target-guard (--op ddl) with the role that owns the tag.",
      `CREATE TAG IF NOT EXISTS ${f.tag} ALLOWED_VALUES ${Object.keys(tiers).map(sqlString).join(", ")};`,
    ];
    for (const [id, n] of models) {
      if (!n.database || !n.schema) {
        problems.push(`${id}: no database or schema in the manifest`);
        continue;
      }
      const kind = n.config?.materialized === "view" ? "VIEW" : "TABLE";
      if (n.config?.materialized === "ephemeral") continue;
      const rel = [n.database, n.schema, n.alias ?? n.name].map(sfIdent).join(".");
      const decl = Object.values(n.columns ?? {});
      if (!decl.length) problems.push(`${id}: declares no columns`);
      for (const c of decl) {
        const t = dbtColumnTier(c);
        if (!t) problems.push(`${id}.${c.name}: no meta.classification`);
        else if (!Object.hasOwn(tiers, t)) problems.push(`${id}.${c.name}: tier ${t} is not in the tiers file`);
        else lines.push(`ALTER ${kind} ${rel} MODIFY COLUMN ${sfIdent(c.name)} SET TAG ${f.tag} = ${sqlString(t)};`);
      }
    }
    if (problems.length) throw new Exit(1, [`classification emit snowflake: ${problems.length} problem(s); nothing emitted`, ...problems.map((p) => `  ${p}`)].join("\n"));
    return lines.join("\n");
  }
  throw new Exit(2, "classification emit: bigquery or snowflake");
}

// Tagged columns from a Prisma schema and/or a dbt manifest: { source, store, column, field, tier }.
function taggedColumns(f, tiers) {
  const cols = [];
  const problems = [];
  if (f.prisma) {
    const { fields } = classifyPrisma(f.prisma, tiers);
    for (const x of fields) {
      if (x.problem || (x.tier && !x.known)) problems.push(`${x.key}: ${x.problem ?? `tier ${x.tier} is not in the tiers file`}`);
      cols.push({ store: `prisma:${x.model.model}`, table: x.model.table, field: x.col.field, column: x.col.name, tier: x.known ? x.tier : null, vector: x.col.unsupported !== null && /^\s*(vector|halfvec|sparsevec)\b/i.test(x.col.unsupported) });
    }
  }
  if (f.manifest) {
    for (const [, n] of dbtModels(f.manifest)) {
      for (const c of Object.values(n.columns ?? {})) {
        const t = dbtColumnTier(c);
        if (t && !Object.hasOwn(tiers, t)) problems.push(`dbt:${n.name}.${c.name}: tier ${t} is not in the tiers file`);
        cols.push({ store: `dbt:${n.name}`, table: n.alias ?? n.name, field: c.name, column: c.name, tier: t && Object.hasOwn(tiers, t) ? t : null, vector: false });
      }
    }
  }
  return { cols, problems };
}

const STORE_KINDS = ["primary", "replica", "warehouse", "export", "log", "embedding", "backup", "cache", "other"];

// Every store holding a personal-data column (from the tags) is on the map, every model holding vectors is
// on it as an embedding store, every entry names how it is deleted, and the backups state their window and
// whether deletions are re-applied after a restore or expire with the backups.
export function deletionMap(argv, env = process.env) {
  const f = parseFlags(argv, ["map", "prisma", "manifest", "tiers"]);
  const mapFile = f.map ?? "governance/deletion-map.json";
  if (!f.prisma && !f.manifest) throw new Exit(2, "deletion-map: give --prisma <schema> and/or --manifest <manifest.json>; with neither, nothing can be compared");
  const tiers = readTiers(f.tiers);
  const map = readJson(mapFile, "--map");
  if (!map || !Array.isArray(map.stores)) throw new Exit(2, `--map ${mapFile}: want { "stores": [ ... ] }`);
  const { cols, problems } = taggedColumns(f, tiers);
  const notes = [];
  const held = new Map();
  let backups = 0;
  map.stores.forEach((s, i) => {
    const label = `stores[${i}]${s?.name ? ` (${s.name})` : ""}`;
    if (!s || typeof s !== "object") return problems.push(`${label}: not an object`);
    if (typeof s.name !== "string" || !s.name.trim()) problems.push(`${label}: no name`);
    if (!STORE_KINDS.includes(s.kind)) problems.push(`${label}: kind must be one of ${STORE_KINDS.join(", ")}`);
    if (typeof s.delete !== "string" || !s.delete.trim()) problems.push(`${label}: no "delete" (the job, test or runbook that deletes a person here)`);
    if (!Array.isArray(s.holds) || !s.holds.length) problems.push(`${label}: no "holds" (prisma:<Model>, dbt:<model> or all)`);
    for (const h of Array.isArray(s.holds) ? s.holds : []) {
      if (h === "all") continue;
      const m = /^(prisma|dbt):([A-Za-z_][A-Za-z0-9_]*)$/.exec(String(h));
      if (!m) {
        problems.push(`${label}: holds ${JSON.stringify(h)}: want prisma:<Model>, dbt:<model> or all`);
        continue;
      }
      if ((m[1] === "prisma" && !f.prisma) || (m[1] === "dbt" && !f.manifest)) {
        notes.push(`NOT CHECKED: ${label} holds ${h}, and no --${m[1] === "prisma" ? "prisma" : "manifest"} was given`);
        continue;
      }
      if (!cols.some((c) => c.store === h)) problems.push(`${label}: holds ${h}, which the schema does not have (stale entry)`);
      held.set(h, [...(held.get(h) ?? []), s]);
    }
    if (s.kind === "backup") {
      backups++;
      if (!(Number.isInteger(s.retention_days) && s.retention_days >= 0)) problems.push(`${label}: a backup states retention_days, the window a deleted person survives in it`);
      if (!["reapply", "expire"].includes(s.after_restore)) problems.push(`${label}: a backup states after_restore: "reapply" (deletions are re-applied after a restore) or "expire" (the data expires with the backups)`);
    }
  });
  const personal = new Map();
  const vectors = new Set();
  for (const c of cols) {
    if (c.tier && tiers[c.tier].personal_data) personal.set(c.store, [...(personal.get(c.store) ?? []), `${c.column} (${c.tier})`]);
    if (c.vector) vectors.add(c.store);
  }
  for (const [store, list] of personal) if (!held.has(store)) problems.push(`${store} holds personal data (${list.slice(0, 5).join(", ")}${list.length > 5 ? ", ..." : ""}) and no store on the map holds it`);
  for (const store of vectors) if (!(held.get(store) ?? []).some((s) => s.kind === "embedding")) problems.push(`${store} has a vector column and is not on the map as an embedding store; embeddings carry their source row's data and are deleted with it`);
  if (personal.size && !backups) problems.push(`personal data is held and the map has no backup store; state the backup window and whether deletions are re-applied after a restore or expire`);
  const untagged = cols.filter((c) => !c.tier).length;
  if (untagged) notes.push(`NOT CHECKED: ${untagged} untagged column(s) are not known to hold personal data; classification prisma / dbt fails them`);
  if (problems.length) throw new Exit(1, [`deletion-map: ${problems.length} problem(s)`, ...problems.map((p) => `  ${p}`), ...notes].join("\n"));
  return [...notes, `deletion-map: ${personal.size} store(s) with personal data, each on the map; ${map.stores.length} map entries`].join("\n");
}

const ENFORCEMENT = {
  "scheduled-job": /google_cloud_scheduler_job|google_cloud_run_v2_job|\bschedule\s*[:=]|\bcron\b/i,
  "partition-expiration": /partition_expiration|expiration_ms|expirationMs|partitionExpiration/i,
  "lifecycle-rule": /lifecycle_rule|"lifecycle"|\blifecycle\s*:|\bage\s*[:=]/i,
};

// A path in the repository: relative, no "..", a regular file.
function repoFile(p, what) {
  if (typeof p !== "string" || !p || path.isAbsolute(p) || p.split(/[\\/]/).includes("..")) return { problem: `${what} ${JSON.stringify(p)}: want a relative path inside the repository` };
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!st) return { problem: `${what} ${p}: no such file` };
  if (!st.isFile()) return { problem: `${what} ${p}: not a regular file` };
  return { text: fs.readFileSync(p, "utf8") };
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Each retention rule names the thing that enforces it, and that thing exists in the repository: a
// scheduled job (with its test), a partition expiration or a bucket lifecycle rule. With tiers, every tier
// that states retention_days has a rule that keeps it no longer.
export function retentionCheck(argv, env = process.env) {
  const f = parseFlags(argv, ["rules", "tiers"]);
  const rulesFile = f.rules ?? "governance/retention.json";
  const j = readJson(rulesFile, "--rules");
  if (!j || !Array.isArray(j.rules) || !j.rules.length) throw new Exit(2, `--rules ${rulesFile}: want { "rules": [ ... ] } with at least one rule`);
  let tiers = null;
  const notes = [];
  if (f.tiers || fs.existsSync(DEFAULT_TIERS)) tiers = readTiers(f.tiers);
  else notes.push(`NOT CHECKED: no ${DEFAULT_TIERS}, so no tier's retention_days is compared with the rules`);
  const problems = [];
  j.rules.forEach((r, i) => {
    const label = `rules[${i}]${r?.name ? ` (${r.name})` : ""}`;
    if (!r || typeof r !== "object") return problems.push(`${label}: not an object`);
    if (typeof r.name !== "string" || !r.name.trim()) problems.push(`${label}: no name`);
    if (!(Number.isInteger(r.keep_days) && r.keep_days > 0)) problems.push(`${label}: keep_days must be a whole number above 0`);
    if (tiers && r.tier !== undefined && !Object.hasOwn(tiers, r.tier)) problems.push(`${label}: tier ${r.tier} is not in the tiers file`);
    const e = r.enforcement;
    if (!e || !Object.hasOwn(ENFORCEMENT, e.kind)) return problems.push(`${label}: enforcement.kind must be one of ${Object.keys(ENFORCEMENT).join(", ")}; a policy with no job is not retention`);
    if (typeof e.id !== "string" || !e.id.trim()) return problems.push(`${label}: enforcement.id names the job, table or rule in enforcement.file`);
    const file = repoFile(e.file, `${label}: enforcement.file`);
    if (file.problem) return problems.push(file.problem);
    if (!new RegExp(`(^|[^A-Za-z0-9_-])${escRe(e.id)}($|[^A-Za-z0-9_-])`).test(file.text)) problems.push(`${label}: ${e.file} does not mention ${e.id}; the enforcement it names does not exist there`);
    else if (!ENFORCEMENT[e.kind].test(file.text)) problems.push(`${label}: ${e.file} has no ${e.kind} in it`);
    if (e.kind === "scheduled-job") {
      const t = repoFile(r.test, `${label}: test`);
      if (t.problem) problems.push(`${t.problem} (a scheduled delete needs a test that seeds an old row, runs the job and finds the row gone)`);
    }
  });
  if (tiers) {
    for (const [name, t] of Object.entries(tiers)) {
      if (!t.retention_days) continue;
      const rs = j.rules.filter((r) => r?.tier === name);
      if (!rs.length) problems.push(`tier ${name} keeps data ${t.retention_days} days, and no rule enforces it`);
      for (const r of rs) if (Number.isInteger(r.keep_days) && r.keep_days > t.retention_days) problems.push(`${r.name ?? "a rule"}: keeps ${name} ${r.keep_days} days; the tier allows ${t.retention_days}`);
    }
  }
  if (problems.length) throw new Exit(1, [`retention: ${problems.length} problem(s)`, ...problems.map((p) => `  ${p}`), ...notes].join("\n"));
  return [...notes, `retention: ${j.rules.length} rule(s), each with an enforcement that exists`].join("\n");
}

// A glob over the working tree: `**` crosses folders, `*` and `?` do not. .git and node_modules are skipped.
function globFiles(pattern) {
  if (path.isAbsolute(pattern) || pattern.split("/").includes("..")) throw new Exit(2, `--module ${pattern}: want a relative path or glob inside the repository`);
  const re = new RegExp(
    `^${pattern
      .split("/")
      .map((seg) => (seg === "**" ? "(?:.*/)?" : `${seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}/`))
      .join("")
      .replace(/\/$/, "")
      .replace(/\(\?:\.\*\/\)\?$/, ".*")}$`,
  );
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d || ".", { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && re.test(p)) out.push(p);
    }
  };
  walk("");
  return out.sort();
}

const WAIVER = /governance:\s*export-ok\b(.*)$/;

// The [open, close] index pairs of each mask call's parentheses on a line.
function maskedSpans(line, maskRe) {
  const spans = [];
  for (const m of line.matchAll(new RegExp(maskRe.source, "g"))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = line.length;
    for (let i = open; i < line.length; i++) {
      if (line[i] === "(") depth++;
      else if (line[i] === ")" && --depth === 0) {
        close = i;
        break;
      }
    }
    spans.push([open, close]);
  }
  return spans;
}

// Advisory: an export module that writes a column whose tier does not allow export, with no mask call on
// that line. A waiver comment with a reason silences one line; a waiver with no reason fails.
export function exportsCheck(argv, env = process.env) {
  const f = parseFlags(argv, ["module", "prisma", "manifest", "tiers", "mask", "strict"], ["module", "mask"]);
  if (!f.module?.length) throw new Exit(2, "exports: --module <path or glob> is required (the modules that write exports)");
  if (!f.prisma && !f.manifest) throw new Exit(2, "exports: give --prisma <schema> and/or --manifest <manifest.json> for the tags");
  if (f.strict !== undefined && !["true", "false"].includes(f.strict)) throw new Exit(2, "--strict true|false");
  const tiers = readTiers(f.tiers);
  const { cols, problems: tagProblems } = taggedColumns(f, tiers);
  const guarded = new Map();
  for (const c of cols) {
    if (!c.tier || tiers[c.tier].export === "allow") continue;
    for (const n of new Set([c.field, c.column])) if (/^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(n)) guarded.set(n, { tier: c.tier, rule: tiers[c.tier].export, store: c.store });
  }
  const masks = f.mask?.length ? f.mask : ["mask"];
  for (const m of masks) if (!/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(m)) throw new Exit(2, `--mask ${m}: want a function name`);
  const maskRe = new RegExp(`(?:^|[^A-Za-z0-9_$.])(?:${masks.map(escRe).join("|")})\\s*\\(`);
  const files = new Set();
  for (const g of f.module) {
    const hit = globFiles(g);
    if (!hit.length) throw new Exit(2, `--module ${g}: matches no file, so no export was read`);
    hit.forEach((x) => files.add(x));
  }
  const findings = [];
  const errors = [...tagProblems];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
    lines.forEach((line, i) => {
      const w = WAIVER.exec(line) ?? (i > 0 ? WAIVER.exec(lines[i - 1]) : null);
      if (WAIVER.test(line) && !WAIVER.exec(line)[1].replace(/^[\s:-]+|\s*(\*\/|-->)?\s*$/g, "")) errors.push(`${file}:${i + 1}: a waiver needs a reason (governance: export-ok <why>)`);
      if (w && w[1].replace(/^[\s:-]+|\s*(\*\/|-->)?\s*$/g, "")) return;
      const masked = maskedSpans(line, maskRe);
      for (const [name, g] of guarded) {
        let written = false;
        for (const m of line.matchAll(new RegExp(`(?<![A-Za-z0-9_$])${escRe(name)}(?![A-Za-z0-9_$])`, "g"))) {
          // An object key or a type annotation (`email: string`, `email?: string`) names the column; it
          // does not write it. A column inside a mask call's parentheses is masked.
          if (/^\s*\??:(?!:)/.test(line.slice(m.index + name.length))) continue;
          if (g.rule === "mask" && masked.some(([a, b]) => m.index > a && m.index < b)) continue;
          written = true;
        }
        if (!written) continue;
        findings.push(`${file}:${i + 1}: ${name} (${g.store}, tier ${g.tier}, export ${g.rule}) ${g.rule === "deny" ? "is in an export" : "is exported with no mask call"}`);
      }
    });
  }
  const strict = f.strict === "true";
  const head = `exports: ${files.size} module(s), ${guarded.size} column name(s) whose tier does not allow export`;
  if (errors.length || (strict && findings.length)) throw new Exit(1, [head, ...errors.map((e) => `  ERROR ${e}`), ...findings.map((x) => `  ${x}`)].join("\n"));
  return [head, ...findings.map((x) => `WARNING ${x}`), findings.length ? "advisory: mask each one, or waive the line with `governance: export-ok <reason>`" : "no unmasked export of a guarded column"].join("\n");
}

// `evidence append --from <entries.json>`: append every entry of another evidence file, in order, each
// validated as `evidence append` would build it. The publishing job uses it to add the entries the check
// job recorded without ever running the check job's code with a write token.
function evidenceFrom(file, target) {
  const src = readJson(file, "--from");
  if (!Array.isArray(src)) throw new Exit(2, `--from ${file}: not a JSON array`);
  const keys = ["check", "date", "result", "run_link", "commit", "detail"];
  for (const [i, e] of src.entries()) {
    const ok =
      e && typeof e === "object" && !Array.isArray(e) && Object.keys(e).every((k) => keys.includes(k)) &&
      typeof e.check === "string" && e.check && RESULTS.includes(e.result) && typeof e.date === "string" && !Number.isNaN(Date.parse(e.date)) &&
      (e.run_link === null || typeof e.run_link === "string") && typeof e.commit === "string" && typeof e.detail === "string";
    if (!ok) throw new Exit(2, `--from ${file}: entry ${i} is not an evidence entry`);
  }
  let n = 0;
  for (const e of src) {
    evidenceAppend(["--file", target, "--check", e.check, "--result", e.result, "--date", e.date, "--commit", e.commit || "unknown", ...(e.run_link ? ["--run-link", e.run_link] : []), ...(e.detail ? ["--detail", e.detail] : [])]);
    n++;
  }
  return `appended ${n} entr${n === 1 ? "y" : "ies"} from ${file} to ${target}`;
}

export function main(argv, env = process.env) {
  const [cmd, sub, ...rest] = argv;
  if (cmd === "version" || cmd === "--version") return VERSION;
  if (cmd === "evidence" && sub === "append") return evidenceAppend(rest, env);
  if (cmd === "monitors") return monitorsCheck(argv.slice(1), env);
  if (cmd === "owner") return ownerCheck(argv.slice(1), env);
  if (cmd === "contract-schema") return contractSchemaCheck(argv.slice(1), env);
  if (cmd === "consumers") return consumersCmd(argv.slice(1), env);
  if (cmd === "classification" && sub === "prisma") return classificationPrisma(rest, env);
  if (cmd === "classification" && sub === "dbt") return classificationDbt(rest, env);
  if (cmd === "classification" && sub === "emit") return classificationEmit(rest, env);
  if (cmd === "deletion-map") return deletionMap(argv.slice(1), env);
  if (cmd === "retention") return retentionCheck(argv.slice(1), env);
  if (cmd === "exports") return exportsCheck(argv.slice(1), env);
  throw new Exit(
    2,
    [
      "usage: governance-check.mjs <command>",
      "  version",
      "  evidence append --check <name> --result pass|fail|not_run [--run-link <url>] [--commit <sha>] [--detail <text>] [--file <path>]",
      "  evidence append --from <entries.json> [--file <path>]",
      "  monitors [--repo <dir>] (--manifest <manifest.json> ... | --gx <gx directory> ... [--gx-python <python>])",
      "  owner (--contracts <dir> | --contract <file> ...) [--manifest <manifest.json>]",
      "  contract-schema --contract <file> (--prisma <schema.prisma or folder> | --manifest <manifest.json> [--catalog <catalog.json>])",
      "  consumers --contract <file> [--format lines|markdown] [--label <path>]",
      "  classification prisma [--schema prisma/schema.prisma] [--base origin/<base>] [--tiers governance/tiers.json] [--emit-comments <migrations dir>]",
      "  classification dbt --manifest target/manifest.json [--catalog target/catalog.json] [--path models/marts ...] [--tiers ...]",
      "  classification emit bigquery --manifest <m> --model <name> --current-schema <bq show --schema json> [--tiers ...]",
      "  classification emit snowflake --manifest <m> --tag <db.schema.tag> [--model <name> ...] [--tiers ...]",
      "  deletion-map [--map governance/deletion-map.json] (--prisma <schema> | --manifest <m>) [--tiers ...]",
      "  retention [--rules governance/retention.json] [--tiers ...]",
      "  exports --module <path or glob> ... (--prisma <schema> | --manifest <m>) [--mask <fn> ...] [--strict true] [--tiers ...]",
    ].join("\n"),
  );
}

if (process.argv[1] && path.basename(process.argv[1]) === "governance-check.mjs") {
  try {
    const out = main(process.argv.slice(2));
    if (out) console.log(String(out).replace(/^(\s*)::/gm, "$1: :"));
  } catch (e) {
    if (e instanceof Exit) {
      // no line of a message may start a workflow command, whatever it interpolated
      console.error(`governance-check: ${e.message}`.replace(/^(\s*)::/gm, "$1: :"));
      process.exit(e.code);
    }
    console.error(`governance-check: ${e?.stack ?? e}`);
    process.exit(2);
  }
}
