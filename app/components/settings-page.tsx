"use client";

import { FormEvent, useState } from "react";
import { clearGuidedCaptureDraft, LEGACY_GUIDED_CAPTURE_KEY } from "./guided-capture-draft";
import { useLanguage } from "./language-provider";
import { useLocalSession } from "./local-session-provider";

const EXTENSION_CHANNEL = "playlist-transfer-extension-session-v1";

function clearPairedExtensionSession(): Promise<boolean> {
  if (typeof BroadcastChannel === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(EXTENSION_CHANNEL);
    const nonce = crypto.randomUUID();
    const timer = window.setTimeout(() => { channel.close(); resolve(false); }, 1_200);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: string; nonce?: string; cleared?: boolean };
      if (data.type !== "SESSION_CLEAR_RESPONSE" || data.nonce !== nonce) return;
      window.clearTimeout(timer); channel.close(); resolve(data.cleared === true);
    };
    channel.postMessage({ type: "SESSION_CLEAR_REQUEST", nonce });
  });
}

function downloadBytes(filename: string, bytes: Uint8Array, type = "application/json") {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}

function downloadJson(filename: string, value: unknown) {
  downloadBytes(filename, new TextEncoder().encode(JSON.stringify(value, null, 2)));
}

export function SettingsPage() {
  const { language, setLanguage } = useLanguage();
  const { api, profile, refreshProfile } = useLocalSession();
  const ru = language === "ru";
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [clearText, setClearText] = useState("");
  const [deleteText, setDeleteText] = useState("");
  const [manualExtensionClearRequired, setManualExtensionClearRequired] = useState(false);
  const [manualExtensionClearConfirmed, setManualExtensionClearConfirmed] = useState(false);
  const [googleRevocationConfirmed, setGoogleRevocationConfirmed] = useState(false);

  async function exportBackup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("backup"); setError(""); setMessage("");
    const form = new FormData(event.currentTarget);
    const passphrase = String(form.get("backupPassphrase") ?? "");
    const confirmation = String(form.get("confirmPassphrase") ?? "");
    if (passphrase !== confirmation) { setBusy(""); setError("BACKUP_PASSPHRASES_DO_NOT_MATCH"); return; }
    try {
      const result = await api<{ filename: string; contentBase64: string }>("/api/data", { method: "POST", body: JSON.stringify({ action: "export-backup", backupPassphrase: passphrase }) });
      const binary = atob(result.contentBase64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      downloadBytes(result.filename, bytes);
      setMessage(ru ? "Зашифрованная переносимая резервная копия создана локально." : "An encrypted portable backup was created locally.");
      event.currentTarget.reset();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "BACKUP_FAILED"); }
    finally { setBusy(""); }
  }

  async function diagnostics() {
    setBusy("diagnostics"); setError("");
    try {
      const result = await api<unknown>("/api/data", { method: "POST", body: JSON.stringify({ action: "diagnostics" }) });
      downloadJson(`playlist-transfer-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, result);
      setMessage(ru ? "Redacted diagnostic bundle сохранён. Tokens и secrets исключены." : "The redacted diagnostic bundle was saved. Tokens and secrets are excluded.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "DIAGNOSTICS_FAILED"); }
    finally { setBusy(""); }
  }

  async function clearHistory() {
    setBusy("clear"); setError("");
    try {
      await api("/api/data", { method: "POST", body: JSON.stringify({ action: "clear-history" }) });
      setClearText(""); setMessage(ru ? "История, snapshots, decisions и receipts удалены локально. Подключения и профиль сохранены." : "History, snapshots, decisions, and receipts were deleted locally. Connections and the profile remain.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "CLEAR_HISTORY_FAILED"); }
    finally { setBusy(""); }
  }

  async function deleteAccount() {
    setBusy("delete"); setError(""); setMessage("");
    try {
      const extensionCleared = manualExtensionClearConfirmed || await clearPairedExtensionSession();
      if (!extensionCleared) {
        setManualExtensionClearRequired(true);
        setError(ru
          ? "EXTENSION_SESSION_CLEAR_REQUIRED: профиль не удалён. Откройте popup расширения, нажмите «Удалить данные расширения», затем подтвердите manual fallback ниже."
          : "EXTENSION_SESSION_CLEAR_REQUIRED: the profile was not deleted. Open the extension popup, choose Delete extension data, then attest the manual fallback below.");
        return;
      }
      setManualExtensionClearConfirmed(true);
      window.sessionStorage.removeItem(LEGACY_GUIDED_CAPTURE_KEY);
      clearGuidedCaptureDraft(window.localStorage);
      await api("/api/data", {
        method: "POST",
        body: JSON.stringify({ action: "delete-account", googleRevocationConfirmed }),
      });
      setManualExtensionClearRequired(false);
      setManualExtensionClearConfirmed(false);
      setGoogleRevocationConfirmed(false);
      setDeleteText("");
      await refreshProfile();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "ACCOUNT_DELETE_FAILED"); }
    finally { setBusy(""); }
  }

  async function lockProfile() {
    setBusy("lock"); setError("");
    try { await api("/api/profile", { method: "POST", body: JSON.stringify({ action: "lock" }) }); await refreshProfile(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "PROFILE_LOCK_FAILED"); setBusy(""); }
  }

  async function changeLanguage(next: "ru" | "en") {
    setLanguage(next);
    setBusy("language");
    setError("");
    try {
      await api("/api/profile", { method: "POST", body: JSON.stringify({ action: "set-language", language: next }) });
      await refreshProfile();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "LANGUAGE_SAVE_FAILED");
    } finally {
      setBusy("");
    }
  }

  return <>
    <p className="notice warning">{ru ? "Удаление профиля fail-closed: сначала приложение должно получить SESSION_CLEAR от связанного MV3 bridge. Если bridge недоступен, удаление остановится; очистите данные в popup расширения и только затем явно подтвердите manual fallback." : "Profile deletion fails closed: the app must first receive SESSION_CLEAR confirmation from the paired MV3 bridge. If the bridge is unavailable, deletion stops; clear extension data in its popup and only then explicitly attest the manual fallback."}</p>
    <header className="page-header"><div><p className="eyebrow">LOCAL DATA · ZERO TELEMETRY</p><h1 className="page-title">{ru ? "Данные и настройки" : "Data & settings"}</h1><p className="page-subtitle">{ru ? "SQLite, зашифрованный vault и журнал находятся на этом компьютере. Экспорт выполняется в браузере из loopback-ответа; облачной копии нет." : "SQLite, the encrypted vault, and the journal stay on this computer. Export is created in the browser from a loopback response; no cloud copy exists."}</p></div><button className="button" type="button" disabled={busy === "lock"} onClick={() => void lockProfile()}>{ru ? "Заблокировать vault" : "Lock vault"}</button></header>
    {error && <p className="notice danger" role="alert">{error}</p>}{message && <p className="notice success" role="status">{message}</p>}
    <section className="grid two"><article className="card"><p className="eyebrow">PROFILE</p><h2>{profile.profile?.displayName}</h2><div className="stack"><div className="list-row"><span>{ru ? "Язык интерфейса" : "Interface language"}</span><div className="choice-row"><button type="button" disabled={busy === "language"} className={`choice-chip ${language === "ru" ? "selected" : ""}`} onClick={() => void changeLanguage("ru")}>RU</button><button type="button" disabled={busy === "language"} className={`choice-chip ${language === "en" ? "selected" : ""}`} onClick={() => void changeLanguage("en")}>EN</button></div></div><div className="list-row"><span>{ru ? "Хранилище" : "Storage"}</span><span className="badge verified">LOCAL SQLITE</span></div><div className="list-row"><span>Telemetry</span><span className="badge verified">OFF</span></div><div className="list-row"><span>{ru ? "Закрытое облако" : "Proprietary cloud"}</span><span className="badge verified">NONE</span></div></div></article><article className="card"><p className="eyebrow">CAPABILITY PROFILE</p><h2>guided-local / zero-budget</h2><div className="stack"><p className="notice"><strong>Spotify:</strong> {ru ? "официальные share URLs + user-operated write; Premium не требуется." : "official share URLs + user-operated write; Premium not required."}</p><p className="notice warning"><strong>SoundCloud:</strong> {ru ? "permalink/oEmbed + user-operated write; Artist Pro не требуется, SC-BASE-LEGAL неизвестен." : "permalink/oEmbed + user-operated write; Artist Pro not required, SC-BASE-LEGAL unresolved."}</p><p className="notice"><strong>YouTube:</strong> {ru ? "бесплатный BYO Data API либо manual URL/Save; quota reset вместо оплаты, DOM/autoclick отсутствует." : "free BYO Data API or manual URL/Save; quota reset rather than payment, with no DOM/autoclick."}</p></div></article></section>

    <section className="section grid two"><article className="card"><p className="eyebrow">ENCRYPTED PORTABLE BACKUP</p><h2>{ru ? "Экспорт подключений" : "Export connections"}</h2><p className="muted">{ru ? "Резервная копия повторно шифруется отдельной фразой. Эта фраза не сохраняется. History и provider content в portable backup не включаются." : "The backup is re-encrypted with a separate phrase that is not stored. History and provider content are not included in the portable backup."}</p><form className="stack" onSubmit={(event) => void exportBackup(event)}><label className="field-label"><span>{ru ? "Фраза резервной копии" : "Backup passphrase"}</span><input name="backupPassphrase" type="password" minLength={10} maxLength={512} required autoComplete="new-password" /></label><label className="field-label"><span>{ru ? "Повторите фразу" : "Repeat passphrase"}</span><input name="confirmPassphrase" type="password" minLength={10} maxLength={512} required autoComplete="new-password" /></label><button className="button primary" type="submit" disabled={busy === "backup"}>{ru ? "Скачать зашифрованный JSON" : "Download encrypted JSON"}</button></form></article><article className="card"><p className="eyebrow">SUPPORT WITHOUT TELEMETRY</p><h2>{ru ? "Redacted диагностика" : "Redacted diagnostics"}</h2><p className="muted">{ru ? "Bundle содержит edition, policy gates, статусы подключений и transfers. Vault secrets и provider tokens удаляются до ответа." : "The bundle contains edition, policy gates, connection states, and transfers. Vault secrets and provider tokens are removed before the response."}</p><button className="button" type="button" disabled={busy === "diagnostics"} onClick={() => void diagnostics()}>{ru ? "Скачать диагностику" : "Download diagnostics"}</button></article></section>

    <section className="section danger-zone settings-danger"><div><p className="eyebrow">IRREVERSIBLE LOCAL ACTIONS</p><h2>{ru ? "Удаление данных" : "Data deletion"}</h2><p className="muted">{ru ? "Эти действия не удаляют плейлисты у провайдеров. Они удаляют только локальные данные приложения." : "These actions do not delete provider playlists. They only remove local application data."}</p></div><div className="grid two"><div className="stack"><label className="field-label"><span>{ru ? "Введите CLEAR для удаления истории" : "Type CLEAR to delete history"}</span><input value={clearText} onChange={(event) => setClearText(event.target.value)} /></label><button className="button danger" type="button" disabled={clearText !== "CLEAR" || busy === "clear"} onClick={() => void clearHistory()}>{ru ? "Удалить history, snapshots и receipts" : "Delete history, snapshots & receipts"}</button></div><div className="stack"><label className="field-label"><span>{ru ? "Введите DELETE для удаления профиля" : "Type DELETE to delete the profile"}</span><input value={deleteText} onChange={(event) => setDeleteText(event.target.value)} /></label><div className="notice"><p><strong>{ru ? "Отзыв Google API access" : "Google API access revocation"}</strong></p><p className="muted small">{ru ? "Если подключён YouTube API, приложение сначала попробует официальный revocation endpoint. Отметьте fallback только после ручного отзыва доступа в Google Security settings." : "If YouTube API is connected, the app first tries the official revocation endpoint. Select the fallback only after manually revoking access in Google Security settings."}</p><a href="https://security.google.com/settings/security/permissions" target="_blank" rel="noreferrer">Google Security permissions</a><label className="checkbox-row"><input type="checkbox" checked={googleRevocationConfirmed} onChange={(event) => setGoogleRevocationConfirmed(event.target.checked)} /><span>{ru ? "Я уже отозвал(а) доступ Google вручную и разрешаю удалить связанные local API Data без повторного сетевого revoke." : "I already revoked Google access manually and authorize deletion of related local API Data without another network revoke."}</span></label></div>{manualExtensionClearRequired && <div className="notice warning"><p><strong>{ru ? "Manual fallback — только после очистки расширения" : "Manual fallback — only after clearing the extension"}</strong></p><ol><li>{ru ? "Откройте popup Playlist-Transfer." : "Open the Playlist-Transfer extension popup."}</li><li>{ru ? "Нажмите «Удалить данные расширения» и подтвердите." : "Choose Delete extension data and confirm."}</li><li>{ru ? "Если расширение не установлено, убедитесь, что его нет в chrome://extensions или edge://extensions." : "If the extension is not installed, verify that it is absent from chrome://extensions or edge://extensions."}</li></ol><label className="checkbox-row"><input type="checkbox" checked={manualExtensionClearConfirmed} onChange={(event) => setManualExtensionClearConfirmed(event.target.checked)} /><span>{ru ? "Я выполнил(а) шаги выше; pairing, handoffs и staged navigation в расширении очищены либо расширение не установлено." : "I completed the steps above; extension pairing, handoffs, and staged navigation are cleared, or the extension is not installed."}</span></label></div>}<button className="button danger" type="button" disabled={deleteText !== "DELETE" || busy === "delete" || (manualExtensionClearRequired && !manualExtensionClearConfirmed)} onClick={() => void deleteAccount()}>{ru ? "Удалить профиль, vault и все локальные данные" : "Delete profile, vault & all local data"}</button></div></div></section>
  </>;
}
