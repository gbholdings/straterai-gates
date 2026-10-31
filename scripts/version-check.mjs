#!/usr/bin/env node
// VERSION in governance-check.mjs must be the tag release.yml will cut for this PR: next-tag.mjs applied to
// the PR's semver label and the repository's v-tags. Two PRs that each bump to the same version, merged in
// turn, otherwise ship a tag whose `governance-check version` prints the one before it.
//
//   PR_LABELS='["semver:minor", ...]' node scripts/version-check.mjs      (tags from `git tag --list 'v*'`)
//
// Exit 0 VERSION matches; 1 it does not; 2 no single semver label, or the tags could not be read.
import { execFileSync } from "node:child_process";
import { nextTag } from "./next-tag.mjs";
import { VERSION } from "./governance-check.mjs";

export function expectedVersion(labels, tags) {
  const picked = labels.filter((l) => /^semver:(major|minor|patch)$/.test(l));
  if (picked.length !== 1) throw Object.assign(new Error(`want exactly one label of semver:major, semver:minor or semver:patch (found ${picked.length})`), { code: 2 });
  return nextTag(picked[0].slice("semver:".length), tags).slice(1);
}

export function versionCheck(version, labels, tags) {
  const want = expectedVersion(labels, tags);
  if (version !== want) throw Object.assign(new Error(`VERSION is ${version}, and this PR will be tagged v${want} (its label on top of ${tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(-1)[0] ?? "no tag"}); set VERSION = "${want}" in scripts/governance-check.mjs`), { code: 1 });
  return `version: VERSION ${version} is the tag this PR will get`;
}

if (process.argv[1]?.endsWith("version-check.mjs")) {
  try {
    let labels;
    try {
      labels = JSON.parse(process.env.PR_LABELS ?? "");
      if (!Array.isArray(labels) || !labels.every((l) => typeof l === "string")) throw new Error("not a list of names");
    } catch (e) {
      throw Object.assign(new Error(`PR_LABELS must be a JSON list of label names: ${e.message}`), { code: 2 });
    }
    const tags = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" }).split("\n").filter(Boolean);
    console.log(versionCheck(VERSION, labels, tags));
  } catch (e) {
    console.error(`version-check: ${e.message}`);
    process.exit(e.code === 1 ? 1 : 2);
  }
}
