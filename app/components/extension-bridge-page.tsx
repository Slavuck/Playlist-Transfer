"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "./language-provider";
import { consumeExtensionBridgeFragment } from "./extension-bridge-memory";
import { appendGuidedCapture } from "./guided-capture-draft";

const PROTOCOL = "playlist-transfer.extension";
const SCHEMA_VERSION = 1;
const IDENTIFIER = /^[A-Za-z0-9_-]{16,128}$/;
const SECRET = /^[A-Za-z0-9_-]{32,128}$/;
const EXTENSION_ID = /^[a-p]{32}$/;
const CHANNEL = "playlist-transfer-extension-session-v1";

type Bootstrap =
  | { mode: "pair"; extensionId: string; pairingId: string; claimSecret: string }
  | { mode: "handoff"; extensionId: string; handoffId: string; sessionId: string }
  | { mode: "none" };
type ExtensionSession = { extensionId: string; sessionId: string; sessionSecret: string; expiresAtMs: number; capabilities?: Record<string, unknown> };
type PublicHandoff = { provider?: string; resourceKind?: string; providerEntityId?: string; videoId?: string; playlistId?: string; redactedDisplayUrl?: string; canonicalUrl?: string; containsSecret?: boolean; capturedAtMs?: number; evidence?: Record<string, unknown> };
type ExtensionResponse<T> = { ok: true; data: T } | { ok: false; error?: { code?: string } };
type ChromeRuntime = { lastError?: { message?: string }; sendMessage: (extensionId: string, message: unknown, callback: (response: unknown) => void) => void };

function requestId(): string { return crypto.randomUUID(); }

function readBootstrap(fragment: string): Bootstrap {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const mode = params.get("mode");
  const extensionId = params.get("extensionId") ?? "";
  if (!EXTENSION_ID.test(extensionId)) return { mode: "none" };
  if (mode === "pair") {
    const pairingId = params.get("pairingId") ?? "";
    const claimSecret = params.get("claimSecret") ?? "";
    return IDENTIFIER.test(pairingId) && SECRET.test(claimSecret) ? { mode, extensionId, pairingId, claimSecret } : { mode: "none" };
  }
  if (mode === "handoff") {
    const handoffId = params.get("handoffId") ?? "";
    const sessionId = params.get("sessionId") ?? "";
    return IDENTIFIER.test(handoffId) && IDENTIFIER.test(sessionId) ? { mode, extensionId, handoffId, sessionId } : { mode: "none" };
  }
  return { mode: "none" };
}

function runtime(): ChromeRuntime | undefined { return (globalThis as unknown as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime; }

function externalMessage<T>(extensionId: string, type: string, body: Record<string, unknown>, auth?: { sessionId: string; sessionSecret: string }): Promise<T> {
  const chromeRuntime = runtime();
  if (!chromeRuntime) return Promise.reject(new Error("EXTENSION_RUNTIME_UNAVAILABLE"));
  const message = { protocol: PROTOCOL, schemaVersion: SCHEMA_VERSION, type, requestId: requestId(), issuedAtMs: Date.now(), ...(auth ? { auth } : {}), body };
  return new Promise<T>((resolve, reject) => chromeRuntime.sendMessage(extensionId, message, (raw) => {
    if (chromeRuntime.lastError) { reject(new Error("EXTENSION_NOT_REACHABLE")); return; }
    const response = raw as ExtensionResponse<T> | undefined;
    if (!response?.ok) { reject(new Error(response?.error?.code ?? "EXTENSION_REQUEST_FAILED")); return; }
    resolve(response.data);
  }));
}

function askPairedTab(extensionId: string, sessionId: string): Promise<ExtensionSession> {
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel(CHANNEL);
    const nonce = requestId();
    const timer = window.setTimeout(() => { channel.close(); reject(new Error("PAIR_TAB_NOT_AVAILABLE")); }, 1_800);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: string; nonce?: string; session?: ExtensionSession };
      if (data.type !== "SESSION_RESPONSE" || data.nonce !== nonce || data.session?.extensionId !== extensionId || data.session.sessionId !== sessionId) return;
      window.clearTimeout(timer); channel.close(); resolve(data.session);
    };
    channel.postMessage({ type: "SESSION_REQUEST", nonce, extensionId, sessionId });
  });
}

export function ExtensionBridgePage() {
  const { language } = useLanguage();
  const ru = language === "ru";
  const [bootstrap, setBootstrap] = useState<Bootstrap>({ mode: "none" });
  const [session, setSession] = useState<ExtensionSession>();
  const [handoff, setHandoff] = useState<PublicHandoff>();
  const [state, setState] = useState<"idle" | "connecting" | "paired" | "claimed" | "closed" | "error">("idle");
  const [error, setError] = useState("");
  const attempted = useRef(false);

  useEffect(() => {
    const parsed = readBootstrap(consumeExtensionBridgeFragment());
    window.setTimeout(() => setBootstrap(parsed), 0);
  }, []);

  const pair = useCallback(async (invite: Extract<Bootstrap, { mode: "pair" }>) => {
    setState("connecting"); setError("");
    try {
      await externalMessage(invite.extensionId, "EXT_HELLO", { clientVersion: "1.0.0" });
      const result = await externalMessage<Omit<ExtensionSession, "extensionId"> & { capabilities?: Record<string, unknown> }>(invite.extensionId, "PAIR_CLAIM", { pairingId: invite.pairingId, claimSecret: invite.claimSecret });
      setSession({ ...result, extensionId: invite.extensionId }); setState("paired");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "PAIR_FAILED"); setState("error"); }
  }, []);

  const claim = useCallback(async (claimInfo: Extract<Bootstrap, { mode: "handoff" }>) => {
    setState("connecting"); setError("");
    try {
      const paired = await askPairedTab(claimInfo.extensionId, claimInfo.sessionId);
      const result = await externalMessage<{ handoff: PublicHandoff }>(claimInfo.extensionId, "HANDOFF_CLAIM", { handoffId: claimInfo.handoffId }, { sessionId: paired.sessionId, sessionSecret: paired.sessionSecret });
      const received = result.handoff;
      setHandoff({ ...received, canonicalUrl: received.containsSecret ? undefined : received.canonicalUrl }); setState("claimed");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "HANDOFF_CLAIM_FAILED"); setState("error"); }
  }, []);

  useEffect(() => {
    if (attempted.current || bootstrap.mode === "none") return;
    attempted.current = true;
    const timer = window.setTimeout(() => {
      if (bootstrap.mode === "pair") void pair(bootstrap); else void claim(bootstrap);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [bootstrap, claim, pair]);

  useEffect(() => {
    if (!session) return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: string; nonce?: string; extensionId?: string; sessionId?: string; target?: Record<string, unknown>; purpose?: string; correlationId?: string };
      if (data.type === "SESSION_REQUEST" && data.nonce && data.extensionId === session.extensionId && data.sessionId === session.sessionId) channel.postMessage({ type: "SESSION_RESPONSE", nonce: data.nonce, session });
      if (data.type === "SESSION_CLEAR_REQUEST" && data.nonce) {
        void externalMessage<{ cleared: boolean }>(session.extensionId, "SESSION_CLEAR", {}, { sessionId: session.sessionId, sessionSecret: session.sessionSecret })
          .then((result) => { channel.postMessage({ type: "SESSION_CLEAR_RESPONSE", nonce: data.nonce, cleared: result.cleared }); setSession(undefined); setState("closed"); })
          .catch((reason: unknown) => channel.postMessage({ type: "SESSION_CLEAR_RESPONSE", nonce: data.nonce, cleared: false, error: reason instanceof Error ? reason.message : "SESSION_CLEAR_FAILED" }));
      }
      if (data.type === "NAVIGATION_STAGE_REQUEST" && data.nonce && data.target && data.purpose) {
        void externalMessage<Record<string, unknown>>(session.extensionId, "NAVIGATION_STAGE", { target: data.target, purpose: data.purpose, correlationId: data.correlationId }, { sessionId: session.sessionId, sessionSecret: session.sessionSecret })
          .then((result) => channel.postMessage({ type: "NAVIGATION_STAGE_RESPONSE", nonce: data.nonce, ok: true, result }))
          .catch((reason: unknown) => channel.postMessage({ type: "NAVIGATION_STAGE_RESPONSE", nonce: data.nonce, ok: false, error: reason instanceof Error ? reason.message : "NAVIGATION_STAGE_FAILED" }));
      }
    };
    return () => channel.close();
  }, [session]);

  function useCapture() {
    if (!handoff || handoff.containsSecret) return;
    appendGuidedCapture(localStorage, { schemaVersion: 1, ...handoff, containsSecret: false });
  }

  async function closeSession() {
    if (!session) return;
    try {
      await externalMessage(session.extensionId, "SESSION_CLOSE", {}, { sessionId: session.sessionId, sessionSecret: session.sessionSecret });
      setSession(undefined); setState("closed");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "SESSION_CLOSE_FAILED"); }
  }

  return <>
    <header className="page-header"><div><p className="eyebrow">MV3 · ACTIVE TAB · ONE-TIME HANDOFF</p><h1 className="page-title">{ru ? "Локальный bridge" : "Local bridge"}</h1><p className="page-subtitle">{ru ? "Единственный разрешённый origin — literal http://127.0.0.1:3210/extension-bridge. Fragment уже удалён из адресной строки до обмена сообщениями." : "The only allowed origin is literal http://127.0.0.1:3210/extension-bridge. The fragment is removed from the address bar before message exchange."}</p></div><span className={`badge ${state === "paired" || state === "claimed" ? "verified" : state === "error" ? "error" : ""}`}>{state.toUpperCase()}</span></header>
    {error && <p className="notice danger" role="alert">{error === "PAIR_TAB_NOT_AVAILABLE" ? (ru ? "Исходная вкладка pairing закрыта или browser-session перезапущена. Откройте popup расширения и подключите приложение снова." : "The original pairing tab is closed or the browser session restarted. Open the extension popup and pair again.") : error}</p>}
    <section className="grid two"><article className="card"><p className="eyebrow">SECURITY CONTRACT</p><h2>{ru ? "Без DOM, cookies и сетевого перехвата" : "No DOM, cookies, or traffic interception"}</h2><div className="badge-row"><span className="badge verified">activeTab</span><span className="badge verified">storage.session</span><span className="badge error">NO contentScripts</span><span className="badge error">NO host permissions</span><span className="badge error">NO auto-click</span></div><p className="muted">{ru ? "Расширение видит URL только после клика по popup, проверяет exact official origin и удаляет pairing/handoff при restart, reload, disable или update." : "The extension sees a URL only after a popup click, validates an exact official origin, and loses pairing/handoffs on restart, reload, disable, or update."}</p></article><article className="card"><p className="eyebrow">HONEST EVIDENCE</p><h2>{ru ? "URL capture не равен проверке" : "URL capture is not verification"}</h2><p className="notice warning">{ru ? "Расширение подтверждает только user gesture, active-tab URL и официальный origin. Оно не доказывает ownership, write access или presence после записи и никогда не создаёт VERIFIED_PROVIDER." : "The extension confirms only a user gesture, active-tab URL, and official origin. It does not prove ownership, write access, or post-write presence and never creates VERIFIED_PROVIDER."}</p></article></section>
    {state === "idle" && bootstrap.mode === "none" && <section className="section card"><p className="eyebrow">PAIRING STARTS IN THE EXTENSION</p><h2>{ru ? "Откройте popup расширения" : "Open the extension popup"}</h2><ol className="clean-list"><li>{ru ? "Соберите и загрузите unpacked MV3 build в Chrome или Edge." : "Build and load the unpacked MV3 package in Chrome or Edge."}</li><li>{ru ? "Нажмите «Подключить локальное приложение» в popup." : "Choose “Connect local application” in the popup."}</li><li>{ru ? "Оставьте открывшуюся вкладку bridge открытой на время browser-session." : "Keep the opened bridge tab available for the browser session."}</li></ol><p className="notice">{ru ? "Pair invite живёт 2 минуты; handoff — 5 минут. Claim одноразовый и replay-protected." : "A pair invite lasts 2 minutes; a handoff lasts 5 minutes. Claims are one-time and replay-protected."}</p></section>}
    {state === "connecting" && <section className="section empty-state"><div><div className="loading-pulse" /><h2>{ru ? "Проверка протокола…" : "Checking protocol…"}</h2><p>{ru ? "Секреты остаются только в памяти этой browser-session." : "Secrets remain in this browser session’s memory only."}</p></div></section>}
    {state === "paired" && session && <section className="section card"><p className="eyebrow">PAIRED FOR THIS BROWSER SESSION</p><h2>{ru ? "Guided connector готов" : "Guided connector is ready"}</h2><p className="notice success">{ru ? "Pairing подтверждён. Теперь откройте официальный Spotify, SoundCloud или YouTube URL, вызовите popup и передайте выбранный resource." : "Pairing is confirmed. Now open an official Spotify, SoundCloud, or YouTube URL, invoke the popup, and hand off the selected resource."}</p><div className="summary-strip"><div><small>Session</small><strong>{session.sessionId.slice(0, 8)}…</strong></div><div><small>{ru ? "Истекает" : "Expires"}</small><strong>{new Date(session.expiresAtMs).toLocaleTimeString(language)}</strong></div><div><small>DOM read</small><strong>FALSE</strong></div><div><small>UI write</small><strong>FALSE</strong></div></div><button className="button danger" type="button" onClick={() => void closeSession()}>{ru ? "Закрыть extension-session" : "Close extension session"}</button></section>}
    {state === "claimed" && handoff && <section className="section card"><div className="card-head"><div><p className="eyebrow">ONE-TIME HANDOFF CLAIMED</p><h2>{displayHandoff(handoff)}</h2></div><span className="badge manual">URL CAPTURE</span></div><div className="target-id"><small>{handoff.provider === "youtube" ? "videoId" : "providerEntityId"}</small><code>{handoff.videoId ?? handoff.providerEntityId ?? handoff.playlistId ?? "service-tab"}</code></div><p className="notice">{handoff.redactedDisplayUrl}</p><div className="badge-row"><span className="badge verified">official origin</span><span className="badge manual">owner unverified</span><span className="badge manual">write access unverified</span>{handoff.containsSecret && <span className="badge error">PRIVATE URL REDACTED</span>}</div>{handoff.containsSecret ? <p className="notice warning">{ru ? "Private SoundCloud token был расшифрован только для одноразового claim и сразу удалён из UI state. Он не помещён в URL, log, clipboard или local draft. Используйте безопасный публичный permalink/export; SoundCloud-перенос выполняется только пошагово самим пользователем." : "The private SoundCloud token was decrypted only for the one-time claim and immediately removed from UI state. It was not placed in a URL, log, clipboard, or local draft. Use a safe public permalink/export; SoundCloud transfer is user-operated step by step only."}</p> : <div className="page-actions"><Link className="button primary" href={handoff.resourceKind === "service-tab" ? "/connections" : "/playlists"} onClick={useCapture}>{handoff.resourceKind === "service-tab" ? (ru ? "Использовать в подключениях" : "Use in Connections") : (ru ? "Добавить в общий draft импорта" : "Add to shared import draft")}</Link>{handoff.redactedDisplayUrl && <button className="button" type="button" onClick={() => void navigator.clipboard.writeText(handoff.redactedDisplayUrl ?? "")}>{ru ? "Копировать безопасный URL" : "Copy safe URL"}</button>}</div>}</section>}
    {state === "closed" && <section className="section empty-state"><div><h2>{ru ? "Сессия закрыта" : "Session closed"}</h2><p>{ru ? "Pending handoffs и навигация этого pairing удалены из storage.session." : "Pending handoffs and navigation for this pairing were removed from storage.session."}</p></div></section>}
  </>;
}

function displayHandoff(handoff: PublicHandoff): string {
  const provider = handoff.provider === "youtube" ? "YouTube / Music" : handoff.provider === "soundcloud" ? "SoundCloud" : handoff.provider === "spotify" ? "Spotify" : "Provider";
  return `${provider} · ${handoff.resourceKind ?? "resource"}`;
}
