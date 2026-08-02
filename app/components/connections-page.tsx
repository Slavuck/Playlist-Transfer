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
type YoutubeOauthConfig = { maintainerClientConfigured: boolean; clientSecretConfigured: boolean; policyGateEnabled: boolean };
type SpotifySpotApiConfig = { installed: boolean; package?: string; version?: string; python?: string; errorCode?: string; policyGateEnabled: boolean };

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
  const [youtubeOauthConfig, setYoutubeOauthConfig] = useState<YoutubeOauthConfig>({ maintainerClientConfigured: false, clientSecretConfigured: false, policyGateEnabled: false });
  const [youtubeOauthNotice, setYoutubeOauthNotice] = useState("");
  const [spotifySpotApiConfig, setSpotifySpotApiConfig] = useState<SpotifySpotApiConfig>({ installed: false, policyGateEnabled: false });
  const [spotifySpotApiNotice, setSpotifySpotApiNotice] = useState("");
  const ru = language === "ru";
  const youtubeApiConnection = connections.find((item) => item.provider === "youtube" && item.strategy === "api" && item.status === "CONNECTED");
  const spotifyApiConnection = connections.find((item) => item.provider === "spotify" && item.strategy === "api" && item.status === "CONNECTED");

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
      const callbackStatus = new URL(window.location.href).searchParams.get("youtube");
      if (callbackStatus) {
        if (callbackStatus === "connected") {
          setYoutubeOauthNotice(ru ? "Google подключён. Библиотека YouTube готова к синхронизации." : "Google is connected. Your YouTube library is ready to sync.");
        } else if (callbackStatus.startsWith("error:")) {
          setError(callbackStatus.slice("error:".length) || "YOUTUBE_OAUTH_FAILED");
        }
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete("youtube");
        window.history.replaceState({}, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
      }
      void reload();
      void api<YoutubeOauthConfig>("/api/oauth/youtube/config").then(setYoutubeOauthConfig).catch(() => undefined);
      void api<SpotifySpotApiConfig>("/api/spotify/connection").then(setSpotifySpotApiConfig).catch(() => undefined);
    }, 0);
    return () => { window.clearTimeout(timer); window.removeEventListener("storage", onStorage); };
  }, [api, reload, ru]);

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

  async function connectSpotApi(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("spotapi-connect"); setError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const accepted = form.get("accepted") === "on";
    try {
      await api<{ connection: Connection }>("/api/spotify/connection", {
        method: "POST",
        body: JSON.stringify({
          cookieHeader: String(form.get("cookieHeader") ?? ""),
          localPrivacyAccepted: accepted,
          providerPoliciesAccepted: accepted,
        }),
      });
      formElement.reset();
      setSpotifySpotApiNotice(ru ? "SpotAPI подключён. Поиск, чтение и запись Spotify-плейлистов доступны." : "SpotAPI is connected. Spotify playlist search, reads, and writes are available.");
      await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "SPOTAPI_CONNECT_FAILED"); }
    finally { setBusy(""); }
  }

  return (
    <>
      <header className="page-header"><div><p className="eyebrow">ACCOUNT ACCESS · HONEST CAPABILITIES</p><h1 className="page-title">{ru ? "Подключения" : "Connections"}</h1><p className="page-subtitle">{ru ? "YouTube использует Google OAuth, Spotify — локальный SpotAPI, а SoundCloud остаётся ручным. Сохранённые метка и URL — только необязательный fallback, а не подключение библиотеки." : "YouTube uses Google OAuth, Spotify uses local SpotAPI, and SoundCloud remains manual. A saved label and URL are only an optional fallback, not a library connection."}</p></div><Link className="button" href="/extension-bridge">MV3 bridge</Link></header>
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
                : "MANUAL FALLBACK SAVED";
          return (
            <article className="card" key={provider.id}>
              <div className="card-head"><span className={`provider-icon ${provider.id}`}>{provider.short}</span><span className={`badge ${connection?.status === "REAUTH_REQUIRED" ? "error" : connection?.strategy === "api" && connection.status === "CONNECTED" ? "verified" : connection ? "manual" : ""}`}>{connectionBadge}</span></div>
              <h2>{provider.name}</h2>
              {connection ? (
                <div className="stack">
                  <p><strong>{connection.accountLabel}</strong><br /><span className="muted small">{connection.strategy.toUpperCase()} · {connection.profileUrl}</span></p>
                  <div className="badge-row"><span className={connection.strategy === "api" ? "badge verified" : "badge manual"}>{connection.strategy === "api" ? "API LIBRARY ACCESS" : "MANUAL FALLBACK · NO LIBRARY ACCESS"}</span>{connection.scopes.map((scope) => <span className="badge" key={scope}>{scope.split("/").pop()}</span>)}</div>
                  {provider.id === "youtube" && connection.strategy === "api" && <><p className="notice small">YouTube API Services · <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube Terms</a> · <a href="/privacy.html">Privacy</a></p><label className="checkbox-row"><input type="checkbox" checked={googleRevocationConfirmed} onChange={(event) => setGoogleRevocationConfirmed(event.target.checked)} /><span>{ru ? "Если automatic revoke недоступен: я уже отозвал доступ в Google Security settings и разрешаю удалить связанные local API Data." : "If automatic revocation is unavailable: I already revoked access in Google Security settings and authorize deletion of related local API Data."}</span></label><a className="button small-button" href="https://security.google.com/settings/security/permissions" target="_blank" rel="noreferrer">Google Security permissions</a></>}
                  <button className="button danger" disabled={busy === provider.id} onClick={() => void disconnect(provider.id)}>{connection.strategy === "api" ? (ru ? "Отключить и удалить credentials" : "Disconnect & delete credentials") : (ru ? "Удалить ручной fallback" : "Delete manual fallback")}</button>
                </div>
              ) : (
                <div className="stack">
                  {provider.id === "youtube" && <p className="notice success small">{ru ? "Для YouTube уже настроен настоящий Google OAuth. Используйте кнопку «Войти через Google» ниже — метка и URL профиля не нужны." : "Real Google OAuth is configured for YouTube. Use the Sign in with Google button below; no profile label or URL is needed."} <a href="#youtube-direct">{ru ? "Перейти к входу" : "Go to sign-in"}</a></p>}
                  {provider.id === "spotify" && <p className="notice success small">{ru ? "Spotify подключается через установленный на этом компьютере SpotAPI: Client ID, Premium и allowlist не нужны. Сессионные cookies хранятся только зашифрованно в локальном vault." : "Spotify connects through SpotAPI installed on this computer: no Client ID, Premium, or allowlist is required. Session cookies are stored only in the encrypted local vault."} <a href="#spotify-direct">{ru ? "Подключить SpotAPI" : "Connect SpotAPI"}</a></p>}
                  {provider.id === "soundcloud" && <p className="notice warning small">{ru ? "Google-вход не даёт доступ к SoundCloud. Настоящий SoundCloud OAuth требует зарегистрированное приложение, Artist Pro у владельца и серверный Client Secret; этих credentials в сборке пока нет." : "Google sign-in does not grant SoundCloud access. Real SoundCloud OAuth requires a registered app, Artist Pro for its owner, and a server-side Client Secret; this build does not have those credentials yet."}</p>}
                  <details className="advanced-panel"><summary>{ru ? "Необязательный ручной fallback (без доступа к библиотеке)" : "Optional manual fallback (no library access)"}</summary><form className="stack advanced-content" onSubmit={(event) => void connectGuided(event, provider.id)}>
                    <label className="field-label"><span>{ru ? "Метка аккаунта" : "Account label"}</span><input name="accountLabel" required maxLength={100} placeholder="@artist" /></label>
                    <label className="field-label"><span>{ru ? "Официальный URL профиля" : "Official profile URL"}</span><input name="profileUrl" type="url" required value={profileUrls[provider.id]} onChange={(event) => setProfileUrls((current) => ({ ...current, [provider.id]: event.target.value }))} placeholder={provider.placeholder} /></label>
                    <label className="checkbox-row"><input name="confirmed" type="checkbox" required /><span>{ru ? "Я открыл(а) этот аккаунт на официальном сайте и подтверждаю выбранную вкладку." : "I opened this account on the official site and attest the selected tab."}</span></label>
                    <p className="notice warning small">{ru ? "Приложение сохранит только ссылку для пошаговых действий. Оно не увидит плейлисты и не сможет записывать в аккаунт через API." : "The app stores only a link for guided actions. It cannot read playlists or write to the account through an API."}</p><button className="button" disabled={busy === provider.id} type="submit">{ru ? "Сохранить ручной fallback" : "Save manual fallback"}</button>
                  </form></details>
                </div>
              )}
              {provider.id === "spotify" && connection?.strategy !== "api" && <p className="notice warning small">{ru ? "Эта запись не авторизует Spotify. Для прямого чтения и записи подключите локальный SpotAPI ниже." : "This record does not authorize Spotify. Connect local SpotAPI below for direct reads and writes."}</p>}
              {provider.id === "youtube" && connection?.strategy !== "api" && <p className="notice success small">{ru ? "Эта запись не нужна для API. Настоящее подключение выполняется кнопкой «Войти через Google» ниже." : "This record is not used by the API. Use the Sign in with Google button below for a real connection."} <a href="#youtube-direct">{ru ? "Перейти" : "Go"}</a></p>}
              {provider.id === "soundcloud" && <p className="notice warning small">SC-BASE-LEGAL: {ru ? "разрешение на автоматизацию не подтверждено. Service-tab capture только подставляет публичный URL аккаунта; перенос остаётся доступен как пошаговый USER-OPERATED режим без DOM/API-записи приложением." : "automation permission is unconfirmed. Service-tab capture only prefills a public account URL; transfer remains available as a step-by-step USER-OPERATED flow with no app-driven DOM/API writes."}</p>}
            </article>
          );
        })}
      </section>
      <section className="section grid two">
        <article className="card" id="spotify-direct">
          <p className="eyebrow">DIRECT ACCOUNT LIBRARY · LOCAL SPOTAPI</p>
          <h2>{ru ? "Подключить Spotify через SpotAPI" : "Connect Spotify through SpotAPI"}</h2>
          <p className="muted">{ru ? "SpotAPI работает без Spotify Developer Client ID и Premium. Приложение использует только вашу текущую веб-сессию для чтения плейлистов, поиска треков, создания плейлиста и добавления песен." : "SpotAPI works without a Spotify Developer Client ID or Premium. The app uses only your current web session to read playlists, search tracks, create a playlist, and add songs."}</p>
          {spotifySpotApiNotice && <p className="notice success" role="status">{spotifySpotApiNotice}</p>}
          {spotifyApiConnection ? <div className="stack"><p className="notice success"><strong>{ru ? "Spotify подключён." : "Spotify connected."}</strong> {ru ? "Теперь застрявший перенос можно пересверить автоматически." : "The stuck transfer can now be rematched automatically."}</p><Link className="button primary" href="/playlists">{ru ? "Открыть мои Spotify-плейлисты" : "Open my Spotify playlists"}</Link></div> : <div className="stack">
            {spotifySpotApiConfig.installed ? <p className="notice success"><strong>SpotAPI {spotifySpotApiConfig.version ?? ""}</strong> · Python {spotifySpotApiConfig.python ?? "—"} · {ru ? "готов к подключению" : "ready to connect"}</p> : <p className="notice danger"><strong>{ru ? "SpotAPI не готов." : "SpotAPI is not ready."}</strong> {spotifySpotApiConfig.errorCode ?? "SPOTAPI_NOT_INSTALLED"}</p>}
            <form className="stack" onSubmit={(event) => void connectSpotApi(event)}>
              <ol className="clean-list"><li>{ru ? "Откройте open.spotify.com, войдите и оставьте вкладку открытой." : "Open open.spotify.com, sign in, and keep the tab open."}</li><li>{ru ? "В DevTools откройте Application → Cookies → https://open.spotify.com." : "In DevTools, open Application → Cookies → https://open.spotify.com."}</li><li>{ru ? "Скопируйте значения sp_dc и, если есть, sp_key в формате ниже." : "Copy sp_dc and, when present, sp_key in the format below."}</li></ol>
              <a className="button" href="https://open.spotify.com/" target="_blank" rel="noreferrer">{ru ? "Открыть Spotify" : "Open Spotify"}</a>
              <label className="field-label"><span>Spotify session cookies</span><input name="cookieHeader" type="password" required autoComplete="off" spellCheck={false} placeholder="sp_dc=…; sp_key=…" /><small>{ru ? "Это секрет уровня входа. Поле маскируется; после проверки cookies шифруются локальным vault и не попадают в URL или логи." : "This is a sign-in secret. The field is masked; after validation the cookies are encrypted by the local vault and never placed in URLs or logs."}</small></label>
              <label className="checkbox-row"><input name="accepted" type="checkbox" required /><span>{ru ? "Я подключаю собственный аккаунт, принимаю Privacy Policy и понимаю, что SpotAPI использует неофициальные приватные endpoints Spotify." : "I am connecting my own account, accept the Privacy Policy, and understand that SpotAPI uses unofficial private Spotify endpoints."} <a href="/privacy.html">Privacy</a> · <a href="https://github.com/Aran404/SpotAPI" target="_blank" rel="noreferrer">SpotAPI</a></span></label>
              <button className="button primary" type="submit" disabled={busy === "spotapi-connect"}>{busy === "spotapi-connect" ? (ru ? "Проверяю сессию…" : "Checking session…") : (ru ? "Подключить SpotAPI" : "Connect SpotAPI")}</button>
            </form>
            {!spotifySpotApiConfig.policyGateEnabled && <p className="notice warning">SPOTAPI_POLICY_GATE_CLOSED</p>}
          </div>}
        </article>
        <article className="card" id="youtube-direct">
          <p className="eyebrow">DIRECT ACCOUNT LIBRARY · OFFICIAL API</p>
          <h2>{ru ? "Войти через Google" : "Sign in with Google"}</h2>
          <p className="muted">{ru ? "После входа приложение показывает owned-плейлисты аккаунта и загружает все videoId. Обычному пользователю не нужно вводить Client ID, если владелец сборки один раз настроил OAuth." : "After sign-in, the app lists owned playlists and loads every videoId. End users do not enter a Client ID once the release maintainer has configured OAuth."}</p>
          {youtubeOauthNotice && <p className="notice success" role="status">{youtubeOauthNotice}</p>}
          {youtubeApiConnection ? <div className="stack"><p className="notice success"><strong>{ru ? "Прямая библиотека подключена." : "Direct library connected."}</strong> {ru ? "Перейдите в Плейлисты, выберите нужные списки и синхронизируйте их одним нажатием." : "Open Playlists, select the lists you need, and sync them in one click."}</p><Link className="button primary" href="/playlists">{ru ? "Открыть мои YouTube-плейлисты" : "Open my YouTube playlists"}</Link></div> : <div className="stack">
            {youtubeOauthConfig.maintainerClientConfigured && !youtubeOauthConfig.clientSecretConfigured && <p className="notice warning"><strong>{ru ? "Google подтвердил тип Desktop, но token endpoint требует client secret этого клиента." : "Google confirms the Desktop type, but this client's token endpoint requires its client secret."}</strong> {ru ? "Скачайте JSON этого OAuth client в Google Cloud и задайте PLAYLIST_TRANSFER_YOUTUBE_CLIENT_SECRET в локальном .env.local. Не вставляйте секрет в форму или публичный репозиторий." : "Download this OAuth client's JSON in Google Cloud and set PLAYLIST_TRANSFER_YOUTUBE_CLIENT_SECRET in the local .env.local file. Do not paste the secret into a form or public repository."}</p>}
            {youtubeOauthConfig.maintainerClientConfigured && youtubeOauthConfig.policyGateEnabled ? <form className="stack" onSubmit={(event) => void startYoutubeOauth(event)}><label className="checkbox-row"><input name="accepted" type="checkbox" required /><span>{ru ? "Я принимаю Privacy Policy и YouTube Terms/API Policies для этой локальной установки." : "I accept the Privacy Policy and YouTube Terms/API Policies for this local installation."} <a href="/privacy.html">Privacy</a> · <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube Terms</a></span></label><button className="button primary" type="submit" disabled={busy === "youtube-oauth"}>{ru ? "Войти через Google" : "Sign in with Google"}</button></form> : <p className="notice warning"><strong>{ru ? "Владелец релиза ещё не завершил одноразовую настройку Google OAuth." : "The release maintainer has not completed the one-time Google OAuth setup."}</strong> {ru ? "После добавления Client ID в конфигурацию здесь останется только кнопка входа." : "Once the Client ID is configured, only the sign-in button remains here."}</p>}
            {!youtubeOauthConfig.maintainerClientConfigured && <details className="advanced-panel"><summary>{ru ? "Настройка для разработчика или BYO-сборки" : "Developer or BYO build setup"}</summary><form className="stack advanced-content" onSubmit={(event) => void startYoutubeOauth(event)}><p className="muted small">{ru ? "Client ID создаёт владелец приложения один раз, а не каждый пользователь. Тип клиента: Desktop app; redirect использует локальный 127.0.0.1." : "The app maintainer creates this Client ID once—not every user. Client type: Desktop app; the redirect uses local 127.0.0.1."}</p><a className="button" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">{ru ? "Открыть Google Cloud Credentials" : "Open Google Cloud Credentials"}</a><label className="field-label"><span>Desktop OAuth Client ID</span><input name="clientId" required pattern=".+\.apps\.googleusercontent\.com" placeholder="….apps.googleusercontent.com" /></label><label className="checkbox-row"><input name="accepted" type="checkbox" required /><span>{ru ? "Я настроил consent screen и принимаю Privacy Policy и YouTube Terms/API Policies." : "I configured the consent screen and accept the Privacy Policy and YouTube Terms/API Policies."}</span></label><button className="button" type="submit" disabled={busy === "youtube-oauth"}>{ru ? "Подключить эту BYO-сборку" : "Connect this BYO build"}</button></form></details>}
          </div>}
        </article>
        <article className="card"><p className="eyebrow">MV3 GUIDED CONNECTOR</p><h2>{ru ? "Расширение не читает страницу" : "The extension does not read the page"}</h2><p className="muted">{ru ? "Default unpacked build получает только URL активной вкладки после вашего клика, хранит handoff в storage.session и умеет лишь поставить навигацию в очередь. DOM, cookies, network и автоматические клики физически отсутствуют." : "The default unpacked build receives only the active-tab URL after your click, stores a handoff in storage.session, and can only stage navigation. DOM, cookies, network access, and automated clicks are physically absent."}</p><div className="badge-row"><span className="badge verified">activeTab</span><span className="badge verified">storage.session</span><span className="badge error">no DOM</span><span className="badge error">no tokens</span></div><Link className="button" href="/extension-bridge">{ru ? "Открыть pairing bridge" : "Open pairing bridge"}</Link></article>
      </section>
    </>
  );
}
