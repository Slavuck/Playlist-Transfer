import { PROTOCOL, SCHEMA_VERSION } from "../src/constants.js";
import { randomBase64Url } from "../src/crypto.js";

export class MemoryStorageArea {
  constructor(seed = {}) {
    this.data = structuredClone(seed);
  }

  async get(key) {
    if (key === null || key === undefined) return structuredClone(this.data);
    if (typeof key === "string") {
      return Object.hasOwn(this.data, key) ? { [key]: structuredClone(this.data[key]) } : {};
    }
    throw new TypeError("Unsupported memory storage key");
  }

  async set(values) {
    Object.assign(this.data, structuredClone(values));
  }

  async clear() {
    this.data = {};
  }
}

export class MockTabs {
  constructor(url = "https://open.spotify.com/") {
    this.activeTab = { id: 7, url };
    this.created = [];
  }

  async query() {
    return [structuredClone(this.activeTab)];
  }

  async create(properties) {
    this.created.push(structuredClone(properties));
    return { id: 100 + this.created.length, ...properties };
  }
}

export function makeMessage(type, body = {}, extra = {}) {
  return {
    protocol: PROTOCOL,
    schemaVersion: SCHEMA_VERSION,
    type,
    requestId: randomBase64Url(16),
    issuedAtMs: extra.issuedAtMs ?? Date.now(),
    ...(extra.auth ? { auth: extra.auth } : {}),
    body,
  };
}

export function externalSender(overrides = {}) {
  return {
    origin: "http://127.0.0.1:3210",
    url: "http://127.0.0.1:3210/extension-bridge",
    frameId: 0,
    documentLifecycle: "active",
    tab: { id: 4, incognito: false },
    ...overrides,
  };
}

export function internalSender(extensionId = "abcdefghijklmnopabcdefghijklmnop") {
  return {
    id: extensionId,
    origin: `chrome-extension://${extensionId}`,
    url: `chrome-extension://${extensionId}/popup.html`,
  };
}

