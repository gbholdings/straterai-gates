#!/usr/bin/env node
// Prints the next vX.Y.Z tag. Usage: next-tag.mjs <major|minor|patch> [existing tags, one per line on stdin]
// No existing v-tag: the first release is v1.0.0 whatever the label says.
import fs from "node:fs";

export function nextTag(label, tags) {
  const vs = tags
    .map((t) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(t.trim()))
    .filter(Boolean)
    .map((m) => m.slice(1).map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  if (!["major", "minor", "patch"].includes(label)) throw new Error(`label must be major, minor or patch, got: ${label}`);
  if (vs.length === 0) return "v1.0.0";
  const [M, m, p] = vs[vs.length - 1];
  if (label === "major") return `v${M + 1}.0.0`;
  if (label === "minor") return `v${M}.${m + 1}.0`;
  return `v${M}.${m}.${p + 1}`;
}

if (process.argv[1]?.endsWith("next-tag.mjs")) {
  try {
    const tags = fs.readFileSync(0, "utf8").split("\n").filter(Boolean);
    console.log(nextTag(process.argv[2], tags));
  } catch (e) {
    console.error(`next-tag: ${e.message}`);
    process.exit(2);
  }
}
