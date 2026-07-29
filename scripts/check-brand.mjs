import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([".git", ".next", ".data", "node_modules"]);
const forbidden = String.fromCharCode(97, 112, 112, 116, 114, 97, 110, 115, 102, 101, 114);
const findings = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (relative.toLocaleLowerCase("en-US").includes(forbidden)) findings.push(`${relative}:filename`);
    if (entry.isDirectory()) {
      await walk(absolute);
      continue;
    }
    if (!entry.isFile()) continue;
    const contents = await readFile(absolute);
    if (contents.toString("utf8").toLocaleLowerCase("en-US").includes(forbidden)) findings.push(`${relative}:content`);
  }
}

await walk(root);
if (findings.length) {
  process.stderr.write(`Legacy brand references found:\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Brand check passed: Playlist-Transfer only.\n");
}
