import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const sourceRoot = path.join(projectRoot, "apps", "extension", "src");
const outputRoot = path.join(projectRoot, "apps", "extension", "dist");
const unpackedRoot = path.join(outputRoot, "chromium-guided-unpacked");

const ALLOWED_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".png", ".svg"]);
const FORBIDDEN_SOURCE_PATTERNS = [
  ["chrome.scripting", "scripting API"],
  ["chrome.cookies", "cookies API"],
  ["chrome.webRequest", "webRequest API"],
  ["chrome.debugger", "debugger API"],
  ["chrome.downloads", "downloads API"],
  ["navigator.clipboard", "clipboard API"],
  ["executeScript", "script injection"],
  ["MutationObserver", "provider DOM observation"],
  ["youtubei", "undocumented YouTube endpoint"],
  ["document.cookie", "cookie access"],
  ["localStorage", "page/browser persistent storage"],
  ["fetch(", "extension network fetch"],
  ["new Function", "dynamic code"],
  ["eval(", "dynamic code"],
];

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolute, relative)));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported extension source entry: ${relative}`);
  }
  return files;
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

async function validateSource(files) {
  if (!files.includes("manifest.json") || !files.includes("worker.js") || !files.includes("popup.html")) {
    throw new Error("Extension source is missing manifest, worker, or popup");
  }
  for (const relative of files) {
    const extension = path.extname(relative).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new Error(`Unexpected extension package file: ${relative}`);
    }
    if (relative.endsWith(".map") || relative.includes("tests/")) {
      throw new Error(`Forbidden build artifact: ${relative}`);
    }
    if (extension !== ".js" && extension !== ".html") continue;
    const contents = await readFile(path.join(sourceRoot, relative), "utf8");
    for (const [pattern, capability] of FORBIDDEN_SOURCE_PATTERNS) {
      if (contents.includes(pattern)) {
        throw new Error(`Default guided build contains forbidden ${capability} in ${relative}`);
      }
    }
    if (/\b(?:from|import)\s*\(?\s*["'](?:https?:|\/\/)/u.test(contents)) {
      throw new Error(`Remote executable import in ${relative}`);
    }
  }

  const manifest = JSON.parse(await readFile(path.join(sourceRoot, "manifest.json"), "utf8"));
  if (manifest.manifest_version !== 3) throw new Error("Extension must use Manifest V3");
  assertEqual(manifest.permissions, ["activeTab", "storage"], "Unexpected manifest permissions");
  for (const key of [
    "host_permissions",
    "optional_host_permissions",
    "optional_permissions",
    "content_scripts",
    "web_accessible_resources",
  ]) {
    if (Object.hasOwn(manifest, key)) throw new Error(`Forbidden manifest key: ${key}`);
  }
  assertEqual(
    manifest.externally_connectable?.matches,
    ["http://127.0.0.1:3210/extension-bridge"],
    "externally_connectable must be the exact loopback bridge",
  );
  if (manifest.background?.service_worker !== "worker.js" || manifest.background?.type !== "module") {
    throw new Error("Expected a module MV3 service worker");
  }
  if (!manifest.content_security_policy?.extension_pages?.includes("connect-src 'none'")) {
    throw new Error("Extension CSP must prohibit network connections");
  }
  return manifest;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(name, contents, checksum) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(33, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(contents.length, 18);
  header.writeUInt32LE(contents.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(name, contents, checksum, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(33, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(contents.length, 20);
  header.writeUInt32LE(contents.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(0, 4);
  footer.writeUInt16LE(0, 6);
  footer.writeUInt16LE(entryCount, 8);
  footer.writeUInt16LE(entryCount, 10);
  footer.writeUInt32LE(centralSize, 12);
  footer.writeUInt32LE(centralOffset, 16);
  footer.writeUInt16LE(0, 20);
  return footer;
}

async function deterministicZip(files, destination) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const relative of [...files].sort()) {
    const name = Buffer.from(relative.replaceAll("\\", "/"), "utf8");
    const contents = await readFile(path.join(unpackedRoot, relative));
    const checksum = crc32(contents);
    const header = localHeader(name, contents, checksum);
    localParts.push(header, name, contents);
    centralParts.push(centralHeader(name, contents, checksum, offset), name);
    offset += header.length + name.length + contents.length;
  }
  const central = Buffer.concat(centralParts);
  const archive = Buffer.concat([
    ...localParts,
    central,
    endOfCentralDirectory(files.length, central.length, offset),
  ]);
  await writeFile(destination, archive);
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function assertSafeOutputPath() {
  const expected = path.join(projectRoot, "apps", "extension", "dist");
  if (path.resolve(outputRoot) !== path.resolve(expected) || !outputRoot.startsWith(projectRoot)) {
    throw new Error("Refusing to clean an unexpected extension output path");
  }
}

export async function buildExtension() {
  const sourceStats = await stat(sourceRoot);
  if (!sourceStats.isDirectory()) throw new Error("Extension source directory is missing");
  const files = await listFiles(sourceRoot);
  const manifest = await validateSource(files);

  assertSafeOutputPath();
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(unpackedRoot, { recursive: true });
  for (const relative of files) {
    const destination = path.join(unpackedRoot, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(sourceRoot, relative), destination);
  }

  const archiveName = `playlist-transfer-extension-${manifest.version}-chromium-guided.zip`;
  const archivePath = path.join(outputRoot, archiveName);
  await deterministicZip(files, archivePath);

  const checksumEntries = [];
  for (const relative of files) {
    const contents = await readFile(path.join(unpackedRoot, relative));
    checksumEntries.push(`${sha256(contents)}  chromium-guided-unpacked/${relative}`);
  }
  checksumEntries.push(`${sha256(await readFile(archivePath))}  ${archiveName}`);
  checksumEntries.sort();
  await writeFile(path.join(outputRoot, "SHA256SUMS"), `${checksumEntries.join("\n")}\n`, "utf8");

  return {
    files: files.length,
    unpackedRoot,
    archivePath,
    archiveSha256: sha256(await readFile(archivePath)),
  };
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const result = await buildExtension();
  process.stdout.write(
    `Built ${result.files} files\nUnpacked: ${result.unpackedRoot}\nArchive SHA-256: ${result.archiveSha256}\n`,
  );
}

