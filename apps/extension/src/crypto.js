import { fail } from "./errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function cryptoApi() {
  if (!globalThis.crypto?.getRandomValues || !globalThis.crypto?.subtle) {
    fail("CRYPTO_UNAVAILABLE");
  }
  return globalThis.crypto;
}

export function bytesToBase64Url(bytes) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function base64UrlToBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    fail("INVALID_BASE64URL");
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let binary;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  } catch {
    fail("INVALID_BASE64URL");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomBase64Url(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  cryptoApi().getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function sha256Base64Url(value) {
  const digest = await cryptoApi().subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const maximum = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximum; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function encryptSessionString(plaintext, keyBase64Url) {
  const keyBytes = base64UrlToBytes(keyBase64Url);
  if (keyBytes.byteLength !== 32) fail("INVALID_ENCRYPTION_KEY");
  const key = await cryptoApi().subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = new Uint8Array(12);
  cryptoApi().getRandomValues(iv);
  const ciphertext = await cryptoApi().subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );
  return {
    algorithm: "AES-256-GCM",
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function decryptSessionString(box, keyBase64Url) {
  if (
    !box ||
    box.algorithm !== "AES-256-GCM" ||
    typeof box.iv !== "string" ||
    typeof box.ciphertext !== "string"
  ) {
    fail("INVALID_ENCRYPTED_PAYLOAD");
  }
  const keyBytes = base64UrlToBytes(keyBase64Url);
  const iv = base64UrlToBytes(box.iv);
  if (keyBytes.byteLength !== 32 || iv.byteLength !== 12) {
    fail("INVALID_ENCRYPTED_PAYLOAD");
  }
  const key = await cryptoApi().subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  try {
    const plaintext = await cryptoApi().subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      base64UrlToBytes(box.ciphertext),
    );
    return decoder.decode(plaintext);
  } catch {
    fail("INVALID_ENCRYPTED_PAYLOAD");
  }
}

