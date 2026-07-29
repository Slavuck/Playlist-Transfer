import { PROTOCOL, SCHEMA_VERSION } from "./constants.js";

const pairStatus = document.getElementById("pair-status");
const tabStatus = document.getElementById("tab-status");
const resourceStatus = document.getElementById("resource-status");
const errorMessage = document.getElementById("error-message");
const pairButton = document.getElementById("pair-button");
const refreshButton = document.getElementById("refresh-button");
const captureResourceButton = document.getElementById("capture-resource-button");
const captureTabButton = document.getElementById("capture-tab-button");
const handoffPanel = document.getElementById("handoff-panel");
const handoffStatus = document.getElementById("handoff-status");
const handoffOpenButton = document.getElementById("handoff-open-button");
const navigationList = document.getElementById("navigation-list");
const navigationEmpty = document.getElementById("navigation-empty");
const clearButton = document.getElementById("clear-button");

let currentContext = null;
let lastHandoffId = null;

const ERROR_TEXT = Object.freeze({
  ACTIVE_TAB_PERMISSION_REQUIRED: "Откройте popup ещё раз на нужной вкладке.",
  AUTH_FAILED: "Сессия подключения недействительна. Подключите приложение снова.",
  HANDOFF_UNAVAILABLE: "Передача уже использована или устарела.",
  NO_ACTIVE_TAB: "Не найдена активная вкладка.",
  PAIR_REQUIRED: "Сначала подключите локальное приложение.",
  POPUP_CONTEXT_EXPIRED: "Контекст вкладки устарел. Нажмите «Обновить».",
  TAB_CHANGED: "Активная вкладка изменилась. Нажмите «Обновить».",
  UNSUPPORTED_ORIGIN: "Откройте Spotify, SoundCloud или YouTube.",
  UNSUPPORTED_PROFILE_TAB: "Для подтверждения аккаунта откройте его публичную страницу профиля.",
  UNSUPPORTED_RESOURCE: "Эта страница не содержит поддерживаемую ссылку.",
  YOUTUBE_VIDEO_ID_REQUIRED: "В YouTube-ссылке отсутствует videoId.",
});

function requestId() {
  return crypto.randomUUID();
}

function send(type, body = {}) {
  const message = {
    protocol: PROTOCOL,
    schemaVersion: SCHEMA_VERSION,
    type,
    requestId: requestId(),
    issuedAtMs: Date.now(),
    body,
  };
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error("EXTENSION_MESSAGE_FAILED"));
        return;
      }
      resolve(response);
    });
  });
}

function showError(code) {
  errorMessage.textContent = ERROR_TEXT[code] || "Действие не выполнено. Повторите безопасный шаг.";
  errorMessage.hidden = false;
}

function clearError() {
  errorMessage.textContent = "";
  errorMessage.hidden = true;
}

async function call(type, body = {}) {
  clearError();
  try {
    const response = await send(type, body);
    if (!response?.ok) {
      showError(response?.error?.code);
      return null;
    }
    return response.data;
  } catch {
    showError("EXTENSION_MESSAGE_FAILED");
    return null;
  }
}

function resourceDescription(resource) {
  if (!resource) return "На этой официальной странице нет поддерживаемого resource URL.";
  const secret = resource.containsSecret ? " · приватный token скрыт" : "";
  const identifier = resource.videoId || resource.providerEntityId || "";
  return `${resource.provider} · ${resource.resourceKind}${identifier ? ` · ${identifier}` : ""}${secret}`;
}

async function loadContext() {
  currentContext = null;
  captureResourceButton.disabled = true;
  captureTabButton.disabled = true;
  tabStatus.textContent = "Проверка текущей вкладки…";
  resourceStatus.hidden = true;

  const data = await call("POPUP_CONTEXT_GET");
  if (!data) return;
  pairStatus.textContent = data.status.paired
    ? "Локальное приложение подключено на эту browser-сессию."
    : "Локальное приложение не подключено.";
  pairButton.textContent = data.status.paired
    ? "Переподключить локальное приложение"
    : "Подключить локальное приложение";

  if (!data.recognized) {
    tabStatus.textContent = "Текущая вкладка не относится к поддерживаемому сервису.";
    return;
  }

  currentContext = data;
  tabStatus.textContent = data.serviceTabEligible
    ? `Публичный профиль ${data.provider} распознан. Account и права не проверены.`
    : `Официальный origin: ${data.provider}. Для handoff аккаунта откройте публичный профиль.`;
  resourceStatus.textContent = resourceDescription(data.resource);
  resourceStatus.hidden = false;
  captureTabButton.disabled = !data.status.paired || !data.serviceTabEligible;
  captureResourceButton.disabled = !data.status.paired || !data.resource;
}

function renderNavigation(intents) {
  navigationList.replaceChildren();
  navigationEmpty.hidden = intents.length > 0;
  for (const intent of intents) {
    const wrapper = document.createElement("div");
    wrapper.className = "navigation-item";
    const description = document.createElement("p");
    description.textContent = `${intent.provider} · ${intent.action} · ${intent.purpose}`;
    const target = document.createElement("p");
    target.className = "muted";
    target.textContent = intent.redactedDisplayUrl;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Открыть официальный сайт";
    button.addEventListener("click", async () => {
      button.disabled = true;
      const opened = await call("NAVIGATION_OPEN", { navigationId: intent.navigationId });
      if (!opened) button.disabled = false;
      else await loadNavigation();
    });
    wrapper.append(description, target, button);
    navigationList.append(wrapper);
  }
}

async function loadNavigation() {
  const data = await call("NAVIGATION_LIST");
  if (data) renderNavigation(data.intents);
}

async function capture(mode) {
  if (!currentContext) return;
  const data = await call("CAPTURE_PROVIDER_URL", {
    contextId: currentContext.contextId,
    mode,
  });
  if (!data) return;
  lastHandoffId = data.handoffId;
  handoffStatus.textContent = `${data.provider} · ${data.resourceKind} · ${data.redactedDisplayUrl}`;
  handoffPanel.hidden = false;
  await loadContext();
}

pairButton.addEventListener("click", async () => {
  pairButton.disabled = true;
  const result = await call("PAIR_INVITE_CREATE");
  if (!result) pairButton.disabled = false;
});

refreshButton.addEventListener("click", async () => {
  await Promise.all([loadContext(), loadNavigation()]);
});

captureResourceButton.addEventListener("click", async () => capture("resource"));
captureTabButton.addEventListener("click", async () => capture("service-tab"));

handoffOpenButton.addEventListener("click", async () => {
  if (!lastHandoffId) return;
  handoffOpenButton.disabled = true;
  const opened = await call("HANDOFF_OPEN_LOCAL_APP", { handoffId: lastHandoffId });
  if (!opened) handoffOpenButton.disabled = false;
});

clearButton.addEventListener("click", async () => {
  const confirmed = globalThis.confirm(
    "Удалить pairing, ожидающие ссылки и переходы из памяти расширения?",
  );
  if (!confirmed) return;
  const data = await call("SESSION_CLEAR");
  if (!data) return;
  lastHandoffId = null;
  handoffPanel.hidden = true;
  await Promise.all([loadContext(), loadNavigation()]);
});

await Promise.all([loadContext(), loadNavigation()]);
