import { LIMITS, SCHEMA_VERSION, STORAGE_KEY, TTL } from "./constants.js";
import {
  constantTimeEqual,
  decryptSessionString,
  encryptSessionString,
  randomBase64Url,
  sha256Base64Url,
} from "./crypto.js";
import { fail } from "./errors.js";

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    activeSessionId: null,
    pairingInvites: {},
    sessions: {},
    contexts: {},
    handoffs: {},
    navigationIntents: {},
    replays: {},
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeState(value) {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) return emptyState();
  const normalized = emptyState();
  normalized.activeSessionId =
    typeof value.activeSessionId === "string" ? value.activeSessionId : null;
  for (const field of [
    "pairingInvites",
    "sessions",
    "contexts",
    "handoffs",
    "navigationIntents",
    "replays",
  ]) {
    normalized[field] = isRecord(value[field]) ? value[field] : {};
  }
  return normalized;
}

function trimOldest(record, maximum, timestampField = "createdAtMs") {
  const entries = Object.entries(record);
  if (entries.length <= maximum) return;
  entries
    .sort((left, right) => Number(left[1]?.[timestampField] || 0) - Number(right[1]?.[timestampField] || 0))
    .slice(0, entries.length - maximum)
    .forEach(([key]) => delete record[key]);
}

function removeSessionData(state, sessionId) {
  delete state.sessions[sessionId];
  for (const [key, value] of Object.entries(state.handoffs)) {
    if (value?.sessionId === sessionId) delete state.handoffs[key];
  }
  for (const [key, value] of Object.entries(state.navigationIntents)) {
    if (value?.sessionId === sessionId) delete state.navigationIntents[key];
  }
  for (const [key, value] of Object.entries(state.replays)) {
    if (value?.sessionId === sessionId) delete state.replays[key];
  }
  if (state.activeSessionId === sessionId) state.activeSessionId = null;
}

function cleanupState(state, nowMs) {
  for (const [key, invite] of Object.entries(state.pairingInvites)) {
    if (!isRecord(invite) || Number(invite.expiresAtMs || 0) + TTL.replayMs <= nowMs) {
      delete state.pairingInvites[key];
    }
  }

  for (const [sessionId, session] of Object.entries(state.sessions)) {
    if (
      !isRecord(session) ||
      Number(session.expiresAtMs || 0) <= nowMs ||
      Number(session.lastSeenAtMs || 0) + TTL.sessionIdleMs <= nowMs
    ) {
      removeSessionData(state, sessionId);
    }
  }

  for (const [key, context] of Object.entries(state.contexts)) {
    if (!isRecord(context) || Number(context.expiresAtMs || 0) <= nowMs) delete state.contexts[key];
  }
  for (const [key, handoff] of Object.entries(state.handoffs)) {
    if (!isRecord(handoff) || Number(handoff.expiresAtMs || 0) <= nowMs) delete state.handoffs[key];
  }
  for (const [key, intent] of Object.entries(state.navigationIntents)) {
    if (!isRecord(intent) || Number(intent.expiresAtMs || 0) <= nowMs) {
      delete state.navigationIntents[key];
    }
  }
  for (const [key, replay] of Object.entries(state.replays)) {
    if (!isRecord(replay) || Number(replay.expiresAtMs || 0) <= nowMs) delete state.replays[key];
  }

  trimOldest(state.pairingInvites, LIMITS.maxPairingInvites);
  trimOldest(state.handoffs, LIMITS.maxHandoffs);
  trimOldest(state.navigationIntents, LIMITS.maxNavigationIntents);
  trimOldest(state.replays, LIMITS.maxReplayRecords, "acceptedAtMs");
}

class AsyncMutex {
  #tail = Promise.resolve();

  async run(operation) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class SessionRepository {
  #storage;
  #mutex = new AsyncMutex();

  constructor(storageArea) {
    if (!storageArea?.get || !storageArea?.set || !storageArea?.clear) {
      throw new TypeError("A chrome.storage.session-compatible area is required");
    }
    this.#storage = storageArea;
  }

  async #read() {
    const result = await this.#storage.get(STORAGE_KEY);
    return normalizeState(result?.[STORAGE_KEY]);
  }

  async #write(state) {
    await this.#storage.set({ [STORAGE_KEY]: state });
  }

  async #mutate(nowMs, operation) {
    return this.#mutex.run(async () => {
      const state = await this.#read();
      cleanupState(state, nowMs);
      const result = await operation(state);
      cleanupState(state, nowMs);
      await this.#write(state);
      return result;
    });
  }

  async status(nowMs) {
    return this.#mutate(nowMs, async (state) => {
      const session = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
      return session
        ? {
            paired: true,
            sessionId: state.activeSessionId,
            expiresAtMs: Math.min(
              session.expiresAtMs,
              session.lastSeenAtMs + TTL.sessionIdleMs,
            ),
          }
        : { paired: false };
    });
  }

  async createPairingInvite(nowMs) {
    const pairingId = randomBase64Url(16);
    const claimSecret = randomBase64Url(32);
    const secretHash = await sha256Base64Url(claimSecret);
    const expiresAtMs = nowMs + TTL.pairingInviteMs;

    await this.#mutate(nowMs, async (state) => {
      state.pairingInvites[pairingId] = {
        pairingId,
        state: "PENDING",
        secretHash,
        createdAtMs: nowMs,
        expiresAtMs,
      };
    });
    return { pairingId, claimSecret, expiresAtMs };
  }

  async claimPairingInvite(pairingId, claimSecret, nowMs) {
    return this.#mutate(nowMs, async (state) => {
      const invite = state.pairingInvites[pairingId];
      if (!invite || invite.state !== "PENDING") fail("PAIR_ALREADY_CLAIMED");
      if (invite.expiresAtMs <= nowMs) fail("PAIR_EXPIRED");
      const presentedHash = await sha256Base64Url(claimSecret);
      if (!constantTimeEqual(invite.secretHash, presentedHash)) fail("AUTH_FAILED");

      for (const sessionId of Object.keys(state.sessions)) removeSessionData(state, sessionId);

      const sessionId = randomBase64Url(16);
      const sessionSecret = randomBase64Url(32);
      const sessionSecretHash = await sha256Base64Url(sessionSecret);
      const encryptionKey = randomBase64Url(32);
      const expiresAtMs = nowMs + TTL.sessionAbsoluteMs;
      state.sessions[sessionId] = {
        sessionId,
        secretHash: sessionSecretHash,
        encryptionKey,
        createdAtMs: nowMs,
        lastSeenAtMs: nowMs,
        expiresAtMs,
      };
      state.activeSessionId = sessionId;
      state.pairingInvites[pairingId] = {
        pairingId,
        state: "CLAIMED",
        createdAtMs: invite.createdAtMs,
        claimedAtMs: nowMs,
        expiresAtMs: invite.expiresAtMs,
      };
      return { sessionId, sessionSecret, expiresAtMs };
    });
  }

  async acceptAuthenticatedRequest(auth, requestId, nowMs) {
    return this.#mutate(nowMs, async (state) => {
      const session = state.sessions[auth.sessionId];
      if (!session || state.activeSessionId !== auth.sessionId) fail("AUTH_FAILED");
      const presentedHash = await sha256Base64Url(auth.sessionSecret);
      if (!constantTimeEqual(session.secretHash, presentedHash)) fail("AUTH_FAILED");

      const replayKey = `${auth.sessionId}.${requestId}`;
      if (state.replays[replayKey]) fail("REQUEST_REPLAYED");
      state.replays[replayKey] = {
        sessionId: auth.sessionId,
        requestId,
        acceptedAtMs: nowMs,
        expiresAtMs: nowMs + TTL.replayMs,
      };
      session.lastSeenAtMs = nowMs;
      return { sessionId: auth.sessionId };
    });
  }

  async closeSession(sessionId, nowMs) {
    await this.#mutate(nowMs, async (state) => removeSessionData(state, sessionId));
  }

  async createPopupContext(details, nowMs) {
    const contextId = randomBase64Url(16);
    const expiresAtMs = nowMs + TTL.popupContextMs;
    await this.#mutate(nowMs, async (state) => {
      state.contexts[contextId] = {
        contextId,
        tabId: details.tabId,
        urlFingerprint: details.urlFingerprint,
        createdAtMs: nowMs,
        expiresAtMs,
      };
    });
    return { contextId, expiresAtMs };
  }

  async consumePopupContext(contextId, tabId, urlFingerprint, nowMs) {
    return this.#mutate(nowMs, async (state) => {
      const context = state.contexts[contextId];
      delete state.contexts[contextId];
      if (!context) fail("POPUP_CONTEXT_EXPIRED");
      if (context.tabId !== tabId || !constantTimeEqual(context.urlFingerprint, urlFingerprint)) {
        fail("TAB_CHANGED");
      }
      return true;
    });
  }

  async createHandoff(payload, nowMs) {
    return this.#mutate(nowMs, async (state) => {
      const sessionId = state.activeSessionId;
      const session = sessionId ? state.sessions[sessionId] : null;
      if (!session) fail("PAIR_REQUIRED");

      const handoffId = randomBase64Url(16);
      const expiresAtMs = nowMs + TTL.handoffMs;
      const storedPayload = structuredClone(payload);
      let secretBox;
      if (storedPayload.containsSecret) {
        if (typeof storedPayload.canonicalUrl !== "string") fail("INVALID_SECRET_URL");
        secretBox = await encryptSessionString(storedPayload.canonicalUrl, session.encryptionKey);
        delete storedPayload.canonicalUrl;
      }

      state.handoffs[handoffId] = {
        handoffId,
        sessionId,
        state: "AVAILABLE",
        createdAtMs: nowMs,
        expiresAtMs,
        payload: storedPayload,
        ...(secretBox ? { secretBox } : {}),
      };
      return { handoffId, sessionId, expiresAtMs };
    });
  }

  async getHandoffOpenInfo(handoffId, nowMs) {
    return this.#mutate(nowMs, async (state) => {
      const handoff = state.handoffs[handoffId];
      if (!handoff || handoff.state !== "AVAILABLE") fail("HANDOFF_UNAVAILABLE");
      return { handoffId, sessionId: handoff.sessionId, expiresAtMs: handoff.expiresAtMs };
    });
  }

  async claimHandoff(handoffId, sessionId, nowMs) {
    return this.#mutate(nowMs, async (state) => {
      const handoff = state.handoffs[handoffId];
      if (!handoff) fail("HANDOFF_EXPIRED");
      if (handoff.state !== "AVAILABLE") fail("HANDOFF_ALREADY_CLAIMED");
      if (handoff.sessionId !== sessionId) fail("AUTH_FAILED");
      const session = state.sessions[sessionId];
      if (!session) fail("AUTH_FAILED");

      const payload = structuredClone(handoff.payload);
      if (handoff.secretBox) {
        payload.canonicalUrl = await decryptSessionString(handoff.secretBox, session.encryptionKey);
      }
      payload.handoffId = handoffId;
      payload.expiresAtMs = handoff.expiresAtMs;
      state.handoffs[handoffId] = {
        handoffId,
        sessionId,
        state: "CLAIMED",
        createdAtMs: handoff.createdAtMs,
        claimedAtMs: nowMs,
        expiresAtMs: handoff.expiresAtMs,
      };
      return payload;
    });
  }

  async stageNavigation(details, sessionId, nowMs) {
    return this.#mutate(nowMs, async (state) => {
      const session = state.sessions[sessionId];
      if (!session || state.activeSessionId !== sessionId) fail("AUTH_FAILED");
      const navigationId = randomBase64Url(16);
      const expiresAtMs = nowMs + TTL.navigationIntentMs;
      let secretBox;
      if (details.containsSecret) {
        secretBox = await encryptSessionString(details.url, session.encryptionKey);
      }
      state.navigationIntents[navigationId] = {
        navigationId,
        sessionId,
        state: "PENDING",
        provider: details.provider,
        action: details.action,
        purpose: details.purpose,
        redactedDisplayUrl: details.redactedDisplayUrl,
        ...(details.correlationId ? { correlationId: details.correlationId } : {}),
        ...(secretBox ? { secretBox } : { url: details.url }),
        createdAtMs: nowMs,
        expiresAtMs,
      };
      return { navigationId, expiresAtMs };
    });
  }

  async listNavigationIntents(nowMs) {
    return this.#mutate(nowMs, async (state) => {
      const sessionId = state.activeSessionId;
      if (!sessionId) return [];
      return Object.values(state.navigationIntents)
        .filter((intent) => intent?.sessionId === sessionId && intent.state === "PENDING")
        .sort((left, right) => left.createdAtMs - right.createdAtMs)
        .map((intent) => ({
          navigationId: intent.navigationId,
          provider: intent.provider,
          action: intent.action,
          purpose: intent.purpose,
          redactedDisplayUrl: intent.redactedDisplayUrl,
          expiresAtMs: intent.expiresAtMs,
        }));
    });
  }

  async consumeNavigationIntent(navigationId, nowMs) {
    return this.#mutate(nowMs, async (state) => {
      const intent = state.navigationIntents[navigationId];
      if (!intent || intent.state !== "PENDING") fail("NAVIGATION_UNAVAILABLE");
      const session = state.sessions[intent.sessionId];
      if (!session || state.activeSessionId !== intent.sessionId) fail("PAIR_REQUIRED");
      const url = intent.secretBox
        ? await decryptSessionString(intent.secretBox, session.encryptionKey)
        : intent.url;
      state.navigationIntents[navigationId] = {
        navigationId,
        sessionId: intent.sessionId,
        state: "OPENED",
        provider: intent.provider,
        action: intent.action,
        purpose: intent.purpose,
        redactedDisplayUrl: intent.redactedDisplayUrl,
        createdAtMs: intent.createdAtMs,
        openedAtMs: nowMs,
        expiresAtMs: intent.expiresAtMs,
      };
      return { url, provider: intent.provider, action: intent.action };
    });
  }

  async clear() {
    await this.#mutex.run(async () => this.#storage.clear());
  }

  async snapshotForTests() {
    return this.#mutex.run(async () => structuredClone(await this.#read()));
  }
}
