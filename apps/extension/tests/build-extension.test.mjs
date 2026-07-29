import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildExtension } from "../../../scripts/build-extension.mjs";

test("guided extension build is deterministic and contains only minimal MV3 capabilities", async () => {
  const first = await buildExtension();
  const firstArchive = await readFile(first.archivePath);
  const second = await buildExtension();
  const secondArchive = await readFile(second.archivePath);
  assert.equal(first.archiveSha256, second.archiveSha256);
  assert.deepEqual(firstArchive, secondArchive);
  assert.equal(firstArchive.readUInt32LE(0), 0x04034b50);

  const manifest = JSON.parse(
    await readFile(`${second.unpackedRoot}/manifest.json`, "utf8"),
  );
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["activeTab", "storage"]);
  assert.equal(Object.hasOwn(manifest, "host_permissions"), false);
  assert.equal(Object.hasOwn(manifest, "content_scripts"), false);
  assert.equal(Object.hasOwn(manifest, "web_accessible_resources"), false);
  assert.deepEqual(manifest.externally_connectable.matches, [
    "http://127.0.0.1:3210/extension-bridge",
  ]);

  const worker = await readFile(`${second.unpackedRoot}/worker.js`, "utf8");
  assert.doesNotMatch(worker, /chrome\.scripting|executeScript|webRequest|youtubei/u);
  const sums = await readFile(`${second.unpackedRoot}/../SHA256SUMS`, "utf8");
  assert.match(sums, /chromium-guided\.zip/u);
});

