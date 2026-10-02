#!/usr/bin/env node
import { readdir, stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";

const root = process.argv[2] && resolve(process.argv[2]);
if (!root) {
  console.error("Usage: node scripts/check-desktop-payload.mjs <staging-directory>");
  process.exit(2);
}

const forbiddenNames = new Set(["session.enc", "config.json"]);
const forbiddenRoots = new Set(["data", ".local-data", "backups"]);
const violations = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = resolve(directory, entry.name);
    const path = relative(root, full);
    const pieces = path.split(sep);
    const fileName = entry.name.toLowerCase();
    if (
      forbiddenNames.has(fileName) ||
      fileName.startsWith(".env") ||
      fileName.endsWith(".log") ||
      (pieces.length === 1 && forbiddenRoots.has(fileName))
    ) {
      violations.push(path);
      continue;
    }
    if (entry.isDirectory()) await visit(full);
  }
}

const rootStat = await stat(root).catch(() => null);
if (!rootStat?.isDirectory()) {
  console.error("Desktop payload staging directory does not exist.");
  process.exit(2);
}
await visit(root);
if (violations.length) {
  console.error(`Desktop payload contains forbidden private paths:\n${violations.sort().join("\n")}`);
  process.exit(1);
}
console.log("Desktop payload path check passed.");
