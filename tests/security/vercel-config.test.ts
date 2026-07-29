import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

type Header = { key: string; value: string };
type VercelConfig = {
  framework?: string | null;
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
  headers?: Array<{ source: string; headers: Header[] }>;
};

function config(relativePath: string): VercelConfig {
  return JSON.parse(readFileSync(path.resolve(relativePath), "utf8")) as VercelConfig;
}

function headerMap(value: VercelConfig): Map<string, string> {
  assert.equal(value.headers?.length, 1);
  assert.equal(value.headers?.[0]?.source, "/(.*)");
  return new Map((value.headers?.[0]?.headers ?? []).map((header) => [header.key.toLowerCase(), header.value]));
}

test("Git deployments can publish only the static website and cannot build the local application", () => {
  const root = config("vercel.json");
  assert.equal(root.framework, null);
  assert.equal(root.installCommand, "");
  assert.equal(root.buildCommand, "true");
  assert.equal(root.outputDirectory, "website");
});

test("both Vercel entry points enforce the same restrictive browser security policy", () => {
  const rootHeaders = headerMap(config("vercel.json"));
  const directHeaders = headerMap(config("website/vercel.json"));
  assert.deepEqual(directHeaders, rootHeaders);

  const csp = rootHeaders.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(rootHeaders.get("permissions-policy"), "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()");
  assert.equal(rootHeaders.get("referrer-policy"), "no-referrer");
  assert.equal(rootHeaders.get("x-content-type-options"), "nosniff");
  assert.equal(rootHeaders.get("x-frame-options"), "DENY");
});
