"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  GUIDED_CAPTURE_DRAFT_KEY,
  migrateLegacyGuidedCapture,
  readGuidedCaptureDraft,
  removeGuidedCaptures,
  type GuidedCapture,
} from "./guided-capture-draft";
import { useLanguage } from "./language-provider";
import { useLocalSession } from "./local-session-provider";

type Provider = "spotify" | "soundcloud" | "youtube";
type Connection = { provider: Provider; accountLabel: string; profileUrl?: string; strategy: "guided" | "api"; status: string; scopes: string[]; limitations: string[] };
type YoutubeOauthConfig = { maintainerClientConfigured: boolean; policyGateEnabled: boolean };

const providers: Array<{ id: Provider; name: string; short: string; placeholder: string }> = [
  { id: "spotify", name: "Spotify", short: "SP", placeholder: "https://open.spotify.com/user/…" },
  { id: "soundcloud", name: "SoundCloud", short: "SC", placeholder: "https://soundcloud.com/your-profile" },
  { id: "youtube", name: "YouTube / Music", short: "YT", placeholder: "https://www.youtube.com/channel/…" },
];

export function ConnectionsPage() {
  const { language } = useLanguage();
  const { api } = useLocalSession();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [serviceTabCapture, setServiceTabCapture] = useState<GuidedCapture>();
  const [profileUrls, setProfileUrls] = useState<Record<Provider, string>>({ spotify: "", soundcloud: "", youtube: "" });
  const [googleRevocationConfirmed, setGoogleRevocationConfirmed] = useState(false);
  const [youtubeOauthConfig, setYoutubeOauthConfig] = useState<YoutubeOauthConfig>({ maintainerClientConfigured: false, policyGateEnabled: false });
  const ru = language === "ru";
  const youtubeApiConnection = connections.find((item) => item.provider === "youtube" && item.strategy === "api" && item.status === "CONNECTED");

  const reload = useCallback(() => api<Connection[]>("/api/connections").then(setConnections).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "LOAD_FAILED")), [api]);
  useEffect(() => {
    const applyDraft = (captures: GuidedCapture[]) => {
      const capture = captures.findLast((entry) => entry.resourceKind === "service-tab" && new URL(entry.canonicalUrl).pathname !== "/");
      setServiceTabCapture(capture);
      if (capture) setProfileUrls((current) => ({ ...current, [capture.provider]: capture.canonicalUrl }));
    };
    applyDraft(migrateLegacyGuidedCapture(window.sessionStorage, window.localStorage).captures);
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && event.key === GUIDED_CAPTURE_DRAFT_KEY) {
        applyDraft(readGuidedCaptureDraft(window.localStorage).captures);
      }
    };
    window.addEventListener("storage", onStorage);
    const timer = window.setTimeout(() => {
      void reload();
      void api<YoutubeOauthConfig>("/api/oauth/youtube/config").then(setYoutubeOauthConfig).catch(() => undefined);
    }, 0);
    return () => { window.clearTimeout(timer); window.removeEventListener("storage", onStorage); };
  }, [api, reload]);

  async function connectGuided(event: FormEvent<HTMLFormElement>, provider: Provider) {
    event.preventDefault(); setError(""); setBusy(provider);
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<Connection[]>("/api/connections", { method: "POST", body: JSON.stringify({ action: "connect-guided", provider, accountLabel: form.get("accountLabel"), profileUrl: form.get("profileUrl"), accountTabConfirmed: form.get("confirmed") === "on" }) });
      setConnections(result);
      const draft = removeGuidedCaptures(window.localStorage, (entry) => entry.provider === provider && entry.resourceKind === "service-tab");
      setServiceTabCapture(draft.captures.findLast((entry) => entry.resourceKind === "service-tab"));
      setProfileUrls((current) => ({ ...current, [provider]: "" }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "CONNECT_FAILED"); }
    finally { setBusy(""); }
  }

  async function disconnect(provider: Provider) {
    setBusy(provider); setError("");
    try {
      setConnections(await api<Connection[]>("/api/connections", {
        method: "POST",
        body: JSON.stringify({ action: "disconnect", provider, providerRevocationConfirmed: provider === "youtube" && googleRevocationConfirmed }),
      }));
      if (provider === "youtube") setGoogleRevocationConfirmed(false);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "DISCONNECT_FAILED"); }
    finally { setBusy(""); }
  }

  async function startYoutubeOauth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("youtube-oauth"); setError("");
    const form = new FormData(event.currentTarget);
    const clientId = String(form.get("clientId") ?? "").trim();
    const accepted = form.get("accepted") === "on";
    try {
      const result = await api<{ authorizationUrl: string }>("/api/oauth/youtube/start", {
        method: "POST",
        body: JSON.stringify({
          ...(clientId ? { clientId } : {}),
          write: true,
          localPrivacyAccepted: accepted,
          providerPoliciesAccepted: accepted,
        }),
      });
      window.location.assign(result.authorizationUrl);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "OAUTH_START_FAILED"); setBusy(""); }
  }

  return (
    <>
      <header className="page-header"><div><p className="eyebrow">ACCOUNT ACCESS · HONEST CAPABILITIES</p><h1 className="page-title">{ru ? "Подключения" : "Connections"}</h1><p className="page-subtitle">{ru ? "Только API OAuth даёт приложению список плейлистов. Подтверждение открытой вкладки сохраняет identity/profile URL для guided workflow, но не читает библиотеку и больше не показывается как прямое подключение." : "Only API OAuth grants the app a playlist library. Attesting an open tab stores identity/profile URL for a guided workflow; it does not read the library and is no longer represented as direct access."}</p></div><Link className="button" href="/extension-bridge">MV3 bridge</Link></header>
      {error && <p className="notice danger" role="alert">{error}</p>}
      {serviceTabCapture && <p className="notice warning" role="status"><strong>MV3 SERVICE-TAB:</strong> {serviceTabCapture.redactedDisplayUrl} · {ru ? "URL профиля подставлен ниже; owner и доступ по-прежнему подтверждаете вы." : "The profile URL is prefilled below; you still attest the owner and access."}</p>}
      <section className="grid three">
        {providers.map((provider) => {
          const connection = connections.find((item) => item.provider === provider.id);
          const connectionBadge = !connection
            ? (ru ? "Не подключён" : "Disconnected")
            : connection.status === "REAUTH_REQUIRED"
              ? "REAUTH REQUIRED"
              : connection.strategy === "api" && connection.status === "CONNECTED"
                ? "API CONNECTED"
                : "IDENTITY SAVED";
          return (
            <article className="card" key={provider.id}>
              <div className="card-head"><span className={`provider-icon ${provider.id}`}>{provider.short}</span><span className={`badge ${connection?.status === "REAUTH_REQUIRED" ? "error" : connection?.strategy === "api" && connection.status === "CONNECTED" ? "verified" : connection ? "manual" : ""}`}>{connectionBadge}</span></div>
              <h2>{provider.name}</h2>
              {connection ? (
                <div className="stack">
                  <p><strong>{connection.accountLabel}</strong><br /><span className="muted small">{connection.strategy.toUpperCase()} · {connection.profileUrl}</span></p>
                  <div className="badge-row"><span className={connection.strategy === "api" ? "badge verified" : "badge manual"}>{connection.strategy === "api" ? "API LIBRARY ACCESS" : "IDENTITY ONLY · NO LIBRARY ACCESS"}</span>{connection.scopes.map((scope) => <span className="badge" key={scope}>{scope.split("/").pop()}</span>)}</div>
                  {provider.id === "youtube" && connection.strategy === "api" && <><p className="notice small">YouTube API Services · <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube Terms</a> · <a href="/privacy.html">Privacy</a></p><label className="checkbox-row"><input type="checkbox" checked={googleRevocationConfirmed} onChange={(event) => setGoogleRevocationConfirmed(event.target.checked)} /><span>{ru ? "Если automatic revoke недоступен: я уже отозвал доступ в Google Security settings и разрешаю удалить связанные local API Data." : "If automatic revocation is unavailable: I already revoked access in Google Security settings and authorize deletion of related local API Data."}</span></label><a className="button small-button" href="https://security.google.com/settings/security/permissions" target="_blank" rel="noreferrer">Google Security permissions</a></>}
                  <button className="button danger" disabled={busy === provider.id} onClick={() => void disconnect(provider.id)}>{ru ? "Отключить и удалить credentials" : "Disconnect & delete credentials"}</button>
                </div>
              ) : (
                <form className="stack" onSubmit={(event) => void connectGuided(event, provider.id)}>
                  <label className="field-label"><span>{ru ? "Метка аккаунта" : "Account label"}</span><input name="accountLabel" required maxLength={100} placeholder="@artist" /></label>
                  <label className="field-label"><span>{ru ? "Официальный URL профиля" : "Official profile URL"}</span><input name="profileUrl" type="url" required value={profileUrls[provider.id]} onChange={(event) => setProfileUrls((current) => ({ ...current, [provider.id]: event.target.value }))} placeholder={provider.placeholder} /></label>
                  <label className="checkbox-row"><input name="confirmed" type="checkbox" required /><span>{ru ? "Я открыл(а) этот аккаунт на официальном сайте и подтверждаю выбранную вкладку." : "I opened this account on the official site and attest the selected tab."}</span></label>
                  <p className="notice warning small">{ru ? "Это не OAuth и не синхронизация: приложение не увидит плейлисты этого аккаунта автоматически." : "This is not OAuth or sync: the app will not see this account's playlists automatically."}</p><button className="button" disabled={busy === provider.id} type="submit">{ru ? "Сохранить identity для guided fallback" : "Save identity for guided fallback"}</button>
                </form>
              )}
              {provider.id === "soundcloud" && <p className="notice warning small">SC-BASE-LEGAL: {ru ? "внешняя позиция не подтверждена. Service-tab capture только подставляет публичный URL аккаунта; transfer-направления остаются BLOCKED_EXTERNAL." : "external position unconfirmed. Service-tab capture only prefills a public account URL; transfer directions remain BLOCKED_EXTERNAL."}</p>}
            </article>
          );
        })}
      </section>
      <section className="section grid two">
        <article className="card" id="youtube-direct">
          <p className="eyebrow">DIRECT ACCOUNT LIBRARY · OFFICIAL API</p>
          <h2>{ru ? "Войти через Google" : "Sign in with Google"}</h2>
          <p className="muted">{ru ? "После входа приложение показывает owned-плейлисты аккаунта и загружает все videoId. Обычному пользователю не нужно вводить Client ID, если владелец сборки один раз настроил OAuth." : "After sign-in, the app lists owned playlists and loads every videoId. End users do not enter a Client ID once the release maintainer has configured OAuth."}</p>
          {youtubeApiConnection ? <div className="stack"><p className="notice success"><strong>{ru ? "Прямая библиотека подключена." : "Direct library connected."}</strong> {ru ? "Перейдите в Плейлисты, выберите нужные списки и синхронизируйте их одним нажатием." : "Open Playlists, select the lists you need, and sync them in one click."}</p><Link className="button primary" href="/playlists">{ru ? "Открыть мои YouTube-плейлисты" : "Open my YouTube playlists"}</Link></div> : <div className="stack">
            {youtubeOauthConfig.maintainerClientConfigured && youtubeOauthConfig.policyGateEnabled ? <form className="stack" onSubmit={(event) => void startYoutubeOauth(event)}><label className="checkbox-row"><input name="accepted" type="checkbox" required /><span>{ru ? "Я принимаю Privacy Policy и YouTube Terms/API Policies для этой локальной установки." : "I accept the Privacy Policy and YouTube Terms/API Policies for this local installation."} <a href="/privacy.html">Privacy</a> · <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube Terms</a></span></label><button className="button primary" type="submit" disabled={busy === "youtube-oauth"}>{ru ? "Войти через Google" : "Sign in with Google"}</button></form> : <p className="notice warning"><strong>{ru ? "Владелец релиза ещё не завершил одноразовую настройку Google OAuth." : "The release maintainer has not completed the one-time Google OAuth setup."}</strong> {ru ? "После добавления Client ID в конфигурацию здесь останется только кнопка входа." : "Once the Client ID is configured, only the sign-in button remains here."}</p>}
            <details className="advanced-panel"><summary>{ru ? "Настройка для разработчика или BYO-сборки" : "Developer or BYO build setup"}</summary><form className="stack advanced-content" onSubmit={(event) => void startYoutubeOauth(event)}><p className="muted small">{ru ? "Client ID создаёт владелец приложения один раз, а не каждый пользователь. Тип клиента: Desktop app; redirect использует локальный 127.0.0.1." : "The app maintainer creates this Client ID once—not every user. Client type: Desktop app; the redirect uses local 127.0.0.1."}</p><a className="button" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">{ru ? "Открыть Google Cloud Credentials" : "Open Google Cloud Credentials"}</a><label className="field-label"><span>Desktop OAuth Client ID</span><input name="clientId" required pattern=".+\.apps\.googleusercontent\.com" placeholder="….apps.googleusercontent.com" /></label><label className="checkbox-row"><input name="accepted" type="checkbox" required /><span>{ru ? "Я настроил consent screen и принимаю Privacy Policy и YouTube Terms/API Policies." : "I configured the consent screen and accept the Privacy Policy and YouTube Terms/API Policies."}</span></label><button className="button" type="submit" disabled={busy === "youtube-oauth"}>{ru ? "Подключить эту BYO-сборку" : "Connect this BYO build"}</button></form></details>
          </div>}
        </article>
        <article className="card"><p className="eyebrow">MV3 GUIDED CONNECTOR</p><h2>{ru ? "Расширение не читает страницу" : "The extension does not read the page"}</h2><p className="muted">{ru ? "Default unpacked build получает только URL активной вкладки после вашего клика, хранит handoff в storage.session и умеет лишь поставить навигацию в очередь. DOM, cookies, network и автоматические клики физически отсутствуют." : "The default unpacked build receives only the active-tab URL after your click, stores a handoff in storage.session, and can only stage navigation. DOM, cookies, network access, and automated clicks are physically absent."}</p><div className="badge-row"><span className="badge verified">activeTab</span><span className="badge verified">storage.session</span><span className="badge error">no DOM</span><span className="badge error">no tokens</span></div><Link className="button" href="/extension-bridge">{ru ? "Открыть pairing bridge" : "Open pairing bridge"}</Link></article>
      </section>
    </>
  );
}
