#!/usr/bin/env node
// Governance gates. Node >= 20, no dependencies. The canonical copy lives in gbholdings/straterai-gates;
// packs keep a copy that `gates-sync.mjs --check` holds equal to it.
//
// Exit codes: 0 pass, 1 the check failed, 2 usage error or a missing input (fail closed),
// 4 an evidence file that cannot be parsed (left untouched).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const VERSION = "1.0.0";
const RESULTS = ["pass", "fail", "not_run"];
const DEFAULT_EVIDENCE = "governance/evidence.json";

class Exit extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseFlags(argv, known) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Exit(2, `unexpected argument: ${a}`);
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (!known.includes(name)) throw new Exit(2, `unknown flag: --${name}`);
    if (eq !== -1) out[name] = a.slice(eq + 1);
    else if (i + 1 < argv.length) out[name] = argv[++i];
    else throw new Exit(2, `--${name} needs a value`);
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

export function main(argv, env = process.env) {
  const [cmd, sub, ...rest] = argv;
  if (cmd === "version" || cmd === "--version") return VERSION;
  if (cmd === "evidence" && sub === "append") return evidenceAppend(rest, env);
  throw new Exit(2, `usage: governance-check.mjs version | evidence append --check <name> --result pass|fail|not_run [--run-link <url>] [--commit <sha>] [--detail <text>] [--file <path>]`);
}

if (process.argv[1] && path.basename(process.argv[1]) === "governance-check.mjs") {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof Exit) {
      console.error(`governance-check: ${e.message}`);
      process.exit(e.code);
    }
    throw e;
  }
}
