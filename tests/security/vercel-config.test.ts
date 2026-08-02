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
  regions?: string[];
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

test("Git deployments build the hosted Next application and never publish the old static shell", () => {
  const root = config("vercel.json");
  assert.equal(root.framework, "nextjs");
  assert.equal(root.installCommand, "npm ci");
  assert.equal(root.buildCommand, "npm run build");
  assert.equal(root.outputDirectory, ".next");
  assert.deepEqual(root.regions, ["fra1"]);
});

test("legacy static website keeps its restrictive browser security policy", () => {
  const headers = headerMap(config("website/vercel.json"));
  const csp = headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()")
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("x-frame-options"), "DENY");
});
