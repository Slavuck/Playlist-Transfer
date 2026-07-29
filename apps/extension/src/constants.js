export const PROTOCOL = "playlist-transfer.extension";
export const SCHEMA_VERSION = 1;

export const APP_ORIGIN = "http://127.0.0.1:3210";
export const BRIDGE_PATH = "/extension-bridge";
export const BRIDGE_URL = `${APP_ORIGIN}${BRIDGE_PATH}`;

export const STORAGE_KEY = "playlistTransferGuidedSessionV1";

export const TTL = Object.freeze({
  popupContextMs: 30_000,
  pairingInviteMs: 120_000,
  requestPastMs: 30_000,
  requestFutureMs: 5_000,
  replayMs: 120_000,
  handoffMs: 300_000,
  navigationIntentMs: 600_000,
  sessionIdleMs: 1_800_000,
  sessionAbsoluteMs: 7_200_000,
});

export const LIMITS = Object.freeze({
  messageBytes: 32 * 1024,
  urlBytes: 2_048,
  queryCharacters: 256,
  labelCharacters: 120,
  maxPairingInvites: 5,
  maxHandoffs: 50,
  maxNavigationIntents: 20,
  maxReplayRecords: 256,
});

export const GUIDED_CAPABILITIES = Object.freeze({
  profile: "guided-local",
  activeTabUrlCapture: true,
  typedNavigation: true,
  oneTimeHandoff: true,
  domRead: false,
  uiWrite: false,
  contentScripts: false,
  providerNetworkRead: false,
  youtubeDom: false,
  youtubeAutoClick: false,
  providerReadBack: false,
});

export const PURPOSES = Object.freeze([
  "READ_SOURCE",
  "SEARCH_CANDIDATE",
  "OPEN_DESTINATION",
  "MANUAL_ADD",
  "RECONCILE",
]);

