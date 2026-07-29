import {
  APP_ORIGIN,
  BRIDGE_PATH,
  GUIDED_CAPABILITIES,
  LIMITS,
  PROTOCOL,
  PURPOSES,
  SCHEMA_VERSION,
  TTL,
} from "./constants.js";
import { fail, toPublicError } from "./errors.js";
import { buildNavigationTarget } from "./url-policy.js";

const UTF8 = new TextEncoder();
const IDENTIFIER = /^[A-Za-z0-9_-]{16,128}$/u;
const SECRET = /^[A-Za-z0-9_-]{32,128}$/u;
const CORRELATION = /^[A-Za-z0-9_.:-]{1,64}$/u;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value, code = "BAD_SCHEMA") {
  if (!isRecord(value)) fail(code);
  return value;
}

function assertKeys(value, required, optional = []) {
  assertRecord(value);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("BAD_SCHEMA");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("BAD_SCHEMA");
  }
}

function assertString(value, options = {}) {
  if (typeof value !== "string") fail("BAD_SCHEMA");
  if (options.min !== undefined && value.length < options.min) fail("BAD_SCHEMA");
  if (options.max !== undefined && value.length > options.max) fail("BAD_SCHEMA");
  if (options.pattern && !options.pattern.test(value)) fail("BAD_SCHEMA");
  if (options.values && !options.values.includes(value)) fail("BAD_SCHEMA");
  return value;
}

function assertNumber(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail("BAD_SCHEMA");
  return value;
}

function validateMeta(message) {
  if (message.protocol !== PROTOCOL || message.schemaVersion !== SCHEMA_VERSION) {
    fail("UNSUPPORTED_PROTOCOL");
  }
  assertString(message.type, { min: 1, max: 64 });
  assertString(message.requestId, { pattern: IDENTIFIER });
  assertNumber(message.issuedAtMs);
}

function validateAuth(auth) {
  assertKeys(auth, ["sessionId", "sessionSecret"]);
  assertString(auth.sessionId, { pattern: IDENTIFIER });
  assertString(auth.sessionSecret, { pattern: SECRET });
  return { sessionId: auth.sessionId, sessionSecret: auth.sessionSecret };
}

function validateTarget(target) {
  assertRecord(target);
  const provider = assertString(target.provider, {
    values: ["spotify", "soundcloud", "youtube"],
  });
  const action = assertString(target.action, { min: 1, max: 32 });

  if (provider === "spotify" && action === "search") {
    assertKeys(target, ["provider", "action", "query"]);
    assertString(target.query, { min: 1, max: LIMITS.queryCharacters });
  } else if (provider === "spotify" && action === "track") {
    assertKeys(target, ["provider", "action", "trackId"]);
    assertString(target.trackId, { min: 1, max: 64 });
  } else if (provider === "spotify" && action === "playlist") {
    assertKeys(target, ["provider", "action", "playlistId"]);
    assertString(target.playlistId, { min: 1, max: 64 });
  } else if (provider === "youtube" && action === "search") {
    assertKeys(target, ["provider", "action", "query"]);
    assertString(target.query, { min: 1, max: LIMITS.queryCharacters });
  } else if (provider === "youtube" && action === "video") {
    assertKeys(target, ["provider", "action", "videoId"]);
    assertString(target.videoId, { min: 1, max: 64 });
  } else if (provider === "youtube" && action === "playlist") {
    assertKeys(target, ["provider", "action", "playlistId"]);
    assertString(target.playlistId, { min: 1, max: 160 });
  } else if (provider === "youtube" && action === "playlists-home") {
    assertKeys(target, ["provider", "action"]);
  } else if (provider === "soundcloud" && action === "search") {
    assertKeys(target, ["provider", "action", "query"]);
    assertString(target.query, { min: 1, max: LIMITS.queryCharacters });
  } else if (provider === "soundcloud" && action === "permalink") {
    assertKeys(target, ["provider", "action", "url"]);
    assertString(target.url, { min: 1, max: LIMITS.urlBytes });
  } else {
    fail("INVALID_NAVIGATION_TARGET");
  }

  buildNavigationTarget(target);
  return structuredClone(target);
}

function validateExternalBody(message) {
  switch (message.type) {
    case "EXT_HELLO": {
      assertKeys(message, ["protocol", "schemaVersion", "type", "requestId", "issuedAtMs", "body"]);
      assertKeys(message.body, ["clientVersion"]);
      assertString(message.body.clientVersion, { min: 1, max: 64 });
      return { body: { clientVersion: message.body.clientVersion } };
    }
    case "PAIR_CLAIM": {
      assertKeys(message, ["protocol", "schemaVersion", "type", "requestId", "issuedAtMs", "body"]);
      assertKeys(message.body, ["pairingId", "claimSecret"]);
      assertString(message.body.pairingId, { pattern: IDENTIFIER });
      assertString(message.body.claimSecret, { pattern: SECRET });
      return {
        body: {
          pairingId: message.body.pairingId,
          claimSecret: message.body.claimSecret,
        },
      };
    }
    case "HANDOFF_CLAIM": {
      assertKeys(message, ["protocol", "schemaVersion", "type", "requestId", "issuedAtMs", "auth", "body"]);
      assertKeys(message.body, ["handoffId"]);
      assertString(message.body.handoffId, { pattern: IDENTIFIER });
      return { auth: validateAuth(message.auth), body: { handoffId: message.body.handoffId } };
    }
    case "NAVIGATION_STAGE": {
      assertKeys(message, ["protocol", "schemaVersion", "type", "requestId", "issuedAtMs", "auth", "body"]);
      assertKeys(message.body, ["target", "purpose"], ["correlationId"]);
      const purpose = assertString(message.body.purpose, { values: PURPOSES });
      let correlationId;
      if (message.body.correlationId !== undefined) {
        correlationId = assertString(message.body.correlationId, { pattern: CORRELATION });
      }
      return {
        auth: validateAuth(message.auth),
        body: {
          target: validateTarget(message.body.target),
          purpose,
          ...(correlationId ? { correlationId } : {}),
        },
      };
    }
    case "SESSION_CLOSE": {
      assertKeys(message, ["protocol", "schemaVersion", "type", "requestId", "issuedAtMs", "auth", "body"]);
      assertKeys(message.body, []);
      return { auth: validateAuth(message.auth), body: {} };
    }
    case "SESSION_CLEAR": {
      assertKeys(message, ["protocol", "schemaVersion", "type", "requestId", "issuedAtMs", "auth", "body"]);
      assertKeys(message.body, []);
      return { auth: validateAuth(message.auth), body: {} };
    }
    default:
      fail("UNKNOWN_MESSAGE_TYPE");
  }
}

export function assertMessageSize(message) {
  let serialized;
  try {
    serialized = JSON.stringify(message);
  } catch {
    fail("BAD_SCHEMA");
  }
  if (serialized === undefined || UTF8.encode(serialized).byteLength > LIMITS.messageBytes) {
    fail("PAYLOAD_TOO_LARGE");
  }
}

export function validateExternalMessage(message) {
  assertMessageSize(message);
  assertRecord(message);
  validateMeta(message);
  const validated = validateExternalBody(message);
  return {
    protocol: PROTOCOL,
    schemaVersion: SCHEMA_VERSION,
    type: message.type,
    requestId: message.requestId,
    issuedAtMs: message.issuedAtMs,
    ...validated,
  };
}

export function validateInternalMessage(message) {
  assertMessageSize(message);
  assertKeys(message, ["protocol", "schemaVersion", "type", "requestId", "issuedAtMs", "body"]);
  validateMeta(message);

  switch (message.type) {
    case "POPUP_CONTEXT_GET":
    case "PAIR_INVITE_CREATE":
    case "NAVIGATION_LIST":
    case "SESSION_CLEAR":
      assertKeys(message.body, []);
      break;
    case "CAPTURE_PROVIDER_URL":
      assertKeys(message.body, ["contextId", "mode"]);
      assertString(message.body.contextId, { pattern: IDENTIFIER });
      assertString(message.body.mode, { values: ["resource", "service-tab"] });
      break;
    case "HANDOFF_OPEN_LOCAL_APP":
      assertKeys(message.body, ["handoffId"]);
      assertString(message.body.handoffId, { pattern: IDENTIFIER });
      break;
    case "NAVIGATION_OPEN":
      assertKeys(message.body, ["navigationId"]);
      assertString(message.body.navigationId, { pattern: IDENTIFIER });
      break;
    default:
      fail("UNKNOWN_MESSAGE_TYPE");
  }

  return structuredClone(message);
}

export function assertFreshRequest(issuedAtMs, nowMs) {
  if (issuedAtMs < nowMs - TTL.requestPastMs || issuedAtMs > nowMs + TTL.requestFutureMs) {
    fail("REQUEST_EXPIRED");
  }
}

export function assertExternalSender(sender) {
  if (!isRecord(sender) || sender.id !== undefined || typeof sender.origin !== "string" || typeof sender.url !== "string") {
    fail("WRONG_SENDER_ORIGIN");
  }
  if (sender.origin !== APP_ORIGIN) fail("WRONG_SENDER_ORIGIN");

  let url;
  try {
    url = new URL(sender.url);
  } catch {
    fail("WRONG_SENDER_ORIGIN");
  }
  if (
    url.origin !== APP_ORIGIN ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3210" ||
    url.pathname !== BRIDGE_PATH ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    fail("WRONG_SENDER_ORIGIN");
  }
  if (sender.frameId !== undefined && sender.frameId !== 0) fail("WRONG_SENDER_ORIGIN");
  if (sender.documentLifecycle !== undefined && sender.documentLifecycle !== "active") {
    fail("WRONG_SENDER_ORIGIN");
  }
  if (sender.tab?.incognito === true) fail("WRONG_SENDER_ORIGIN");
}

export function assertInternalSender(sender, extensionId) {
  if (!isRecord(sender) || sender.id !== extensionId || typeof sender.url !== "string") {
    fail("WRONG_INTERNAL_SENDER");
  }
  let url;
  try {
    url = new URL(sender.url);
  } catch {
    fail("WRONG_INTERNAL_SENDER");
  }
  if (
    url.protocol !== "chrome-extension:" ||
    url.hostname !== extensionId ||
    url.port !== "" ||
    url.pathname !== "/popup.html" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    fail("WRONG_INTERNAL_SENDER");
  }
}

export function successResponse(requestId, data, nowMs = Date.now()) {
  return {
    protocol: PROTOCOL,
    schemaVersion: SCHEMA_VERSION,
    requestId,
    ok: true,
    completedAtMs: nowMs,
    data,
  };
}

export function errorResponse(requestId, error, nowMs = Date.now()) {
  return {
    protocol: PROTOCOL,
    schemaVersion: SCHEMA_VERSION,
    requestId: typeof requestId === "string" ? requestId : "invalid-request",
    ok: false,
    completedAtMs: nowMs,
    error: toPublicError(error),
  };
}

export function helloData(extensionVersion) {
  return {
    extensionVersion,
    protocolVersion: SCHEMA_VERSION,
    capabilities: GUIDED_CAPABILITIES,
    pairingRequired: true,
  };
}
