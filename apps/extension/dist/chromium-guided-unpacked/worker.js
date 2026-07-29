import { SessionRepository } from "./session-store.js";
import { GuidedWorkerCore } from "./worker-core.js";

void chrome.storage.session
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch(() => undefined);

const repository = new SessionRepository(chrome.storage.session);
const manifest = chrome.runtime.getManifest();
const core = new GuidedWorkerCore({
  repository,
  tabs: chrome.tabs,
  runtimeId: chrome.runtime.id,
  extensionVersion: manifest.version,
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void core
    .handleInternal(message, sender)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, error: { code: "INTERNAL_ERROR", retryable: false } }));
  return true;
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  void core
    .handleExternal(message, sender)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, error: { code: "INTERNAL_ERROR", retryable: false } }));
  return true;
});

