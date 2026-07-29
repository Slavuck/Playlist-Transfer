"use client";

import Link from "next/link";
import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { parsePlaylistArchive } from "../../packages/importers/src/playlist-archive";
import { type ImportProvider, type ParsedPlaylistOption } from "../../packages/importers/src/playlist-file";
import {
  clearGuidedCaptureDraft,
  GUIDED_CAPTURE_DRAFT_KEY,
  migrateLegacyGuidedCapture,
  readGuidedCaptureDraft,
  removeGuidedCaptures,
  type GuidedCapture,
} from "./guided-capture-draft";
import { useLanguage } from "./language-provider";
import { useLocalSession } from "./local-session-provider";

type Provider = ImportProvider;
type Playlist = { id: string; provider: Provider; providerPlaylistId?: string; providerUrl: string; title: string; ownerLabel: string; eligibility: string; itemCount: number; partial: boolean; sourceVersion: string };
type YoutubePlaylist = { id: string; title: string; itemCount: number; privacyStatus: string; ownership: string };
type Connection = { provider: Provider; accountLabel: string; strategy: "guided" | "api"; status: string; limitations: string[] };

export function PlaylistsPage() {
  const { language } = useLanguage();
  const { api } = useLocalSession();
  const ru = language === "ru";
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [youtubeOwned, setYoutubeOwned] = useState<YoutubePlaylist[]>([]);
  const [youtubeSelected, setYoutubeSelected] = useState<string[]>([]);
  const [youtubeQuery, setYoutubeQuery] = useState("");
  const [youtubeStatus, setYoutubeStatus] = useState("LOADING");
  const [provider, setProvider] = useState<Provider>("spotify");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [captures, setCaptures] = useState<GuidedCapture[]>([]);
  const [tracksText, setTracksText] = useState("");
  const [bulkProvider, setBulkProvider] = useState<Provider>("spotify");
  const [bulkOptions, setBulkOptions] = useState<ParsedPlaylistOption[]>([]);
  const [bulkOptionKey, setBulkOptionKey] = useState("");
  const [bulkPlaylistUrl, setBulkPlaylistUrl] = useState("");
  const [bulkOwner, setBulkOwner] = useState("");
  const [bulkAttested, setBulkAttested] = useState(false);
  const [bulkFileName, setBulkFileName] = useState("");

  const reload = useCallback(() => api<Playlist[]>("/api/playlists").then(setPlaylists), [api]);
  const loadYoutube = useCallback(async () => {
    setYoutubeStatus("LOADING");
    try {
      const items = await api<YoutubePlaylist[]>("/api/youtube/playlists");
      setYoutubeOwned(items);
      setYoutubeStatus("CONNECTED");
    } catch (reason) {
      setYoutubeOwned([]);
      setYoutubeStatus(reason instanceof Error ? reason.message : "YOUTUBE_API_NOT_CONNECTED");
    }
  }, [api]);

  useEffect(() => {
    const applyDraft = (draftCaptures: GuidedCapture[]) => {
      setCaptures(draftCaptures);
      const playlistCapture = draftCaptures.findLast((entry) => entry.resourceKind === "playlist");
      if (playlistCapture) {
        setProvider(playlistCapture.provider);
        setPlaylistUrl(playlistCapture.canonicalUrl);
      }
    };
    applyDraft(migrateLegacyGuidedCapture(window.sessionStorage, window.localStorage).captures);
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && event.key === GUIDED_CAPTURE_DRAFT_KEY) applyDraft(readGuidedCaptureDraft(window.localStorage).captures);
    };
    window.addEventListener("storage", onStorage);
    const timer = window.setTimeout(() => {
      void reload();
      void api<Connection[]>("/api/connections").then((items) => {
        setConnections(items);
        const spotify = items.find((item) => item.provider === "spotify");
        if (spotify) setBulkOwner(spotify.accountLabel);
      }).catch(() => setConnections([]));
      void loadYoutube();
    }, 0);
    return () => { window.clearTimeout(timer); window.removeEventListener("storage", onStorage); };
  }, [api, loadYoutube, reload]);

  const youtubeConnection = connections.find((item) => item.provider === "youtube" && item.strategy === "api" && item.status === "CONNECTED");
  const importedYoutubeIds = useMemo(() => new Set(playlists.filter((item) => item.provider === "youtube" && item.eligibility === "API_VERIFIED_OWNED").map((item) => item.providerPlaylistId)), [playlists]);
  const visibleYoutube = useMemo(() => youtubeOwned.filter((item) => item.title.toLocaleLowerCase().includes(youtubeQuery.trim().toLocaleLowerCase())), [youtubeOwned, youtubeQuery]);
  const selectedBulk = bulkOptions.find((option) => option.key === bulkOptionKey) ?? bulkOptions[0];
  const bulkConnection = connections.find((item) => item.provider === bulkProvider && item.status !== "DISCONNECTED");

  async function snapshotYoutube(playlistIds: string[]) {
    if (!playlistIds.length) return;
    setBusy("youtube-sync"); setError(""); setMessage("");
    try {
      await api("/api/youtube/playlists", { method: "POST", body: JSON.stringify({ action: "snapshot-many", playlistIds }) });
      await reload();
      setYoutubeSelected([]);
      setMessage(ru ? `Синхронизировано плейлистов: ${playlistIds.length}. Треки загружены автоматически.` : `Synced ${playlistIds.length} playlists. Tracks were loaded automatically.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "YOUTUBE_SYNC_FAILED"); }
    finally { setBusy(""); }
  }

  function chooseBulkOption(key: string) {
    setBulkOptionKey(key);
    const option = bulkOptions.find((item) => item.key === key);
    if (!option) return;
    setBulkPlaylistUrl(option.playlistUrl ?? "");
    setBulkOwner(option.ownerLabel ?? connections.find((item) => item.provider === bulkProvider)?.accountLabel ?? "");
  }

  async function readBulkFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(""); setMessage(""); setBulkOptions([]); setBulkFileName(file.name);
    try {
      if (file.size > 25_000_000) throw new Error("IMPORT_FILE_TOO_LARGE");
      const options = parsePlaylistArchive({ data: new Uint8Array(await file.arrayBuffer()), fileName: file.name, provider: bulkProvider });
      setBulkOptions(options);
      setBulkOptionKey(options[0].key);
      setBulkPlaylistUrl(options[0].playlistUrl ?? "");
      setBulkOwner(options[0].ownerLabel ?? connections.find((item) => item.provider === bulkProvider)?.accountLabel ?? "");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "IMPORT_FILE_PARSE_FAILED"); }
  }

  async function importBulk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedBulk) return;
    setBusy("bulk-import"); setError(""); setMessage("");
    try {
      await api("/api/playlists", {
        method: "POST",
        body: JSON.stringify({
          provider: bulkProvider,
          playlistUrl: bulkPlaylistUrl,
          title: selectedBulk.title,
          description: selectedBulk.description,
          ownerLabel: bulkOwner,
          ownershipAttested: bulkAttested,
          editControlAttested: bulkAttested,
          expectedCount: selectedBulk.sourceItemCount,
          tracks: selectedBulk.tracks,
        }),
      });
      await reload();
      setMessage(ru ? `Импортирован «${selectedBulk.title}»: ${selectedBulk.tracks.length} треков одним действием.` : `Imported “${selectedBulk.title}”: ${selectedBulk.tracks.length} tracks in one action.`);
      setBulkOptions([]); setBulkOptionKey(""); setBulkPlaylistUrl(""); setBulkAttested(false); setBulkFileName("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "BULK_IMPORT_FAILED"); }
    finally { setBusy(""); }
  }

  async function importManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      const tracks = String(form.get("tracks") ?? "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
        const parts = line.split("|").map((part) => part.trim());
        if (parts.length < 4) throw new Error("TRACK_LINE_REQUIRES_TITLE_ARTIST_DURATION_URL");
        const [title, artist, duration, ...urlParts] = parts;
        return { title, artist, durationSeconds: duration ? Number(duration) : undefined, url: urlParts.join("|"), unavailable: false };
      });
      await api("/api/playlists", { method: "POST", body: JSON.stringify({ provider, playlistUrl: form.get("playlistUrl"), title: form.get("title"), description: form.get("description"), ownerLabel: form.get("ownerLabel"), ownershipAttested: form.get("ownership") === "on", editControlAttested: form.get("editControl") === "on", expectedCount: Number(form.get("expectedCount")), tracks }) });
      await reload(); event.currentTarget.reset(); setPlaylistUrl(""); setTracksText("");
      setCaptures(removeGuidedCaptures(window.localStorage, (entry) => entry.provider === provider && entry.resourceKind !== "service-tab").captures);
      setMessage(ru ? "Аварийный ручной snapshot сохранён." : "Emergency manual snapshot saved.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "IMPORT_FAILED"); }
  }

  const capturedTracks = captures.filter((entry) => entry.provider === provider && (entry.resourceKind === "track" || entry.resourceKind === "video"));
  function addCapturedTrackLines() {
    if (!capturedTracks.length) return;
    setTracksText((current) => [current.trimEnd(), ...capturedTracks.map((entry) => ` | | | ${entry.canonicalUrl}`)].filter(Boolean).join("\n"));
  }

  return (
    <>
      <header className="page-header"><div><p className="eyebrow">ACCOUNT LIBRARIES · BULK FALLBACK</p><h1 className="page-title">{ru ? "Ваши плейлисты" : "Your playlists"}</h1><p className="page-subtitle">{ru ? "Основной путь — синхронизация библиотеки подключённого аккаунта. Файл-экспорт загружает до 10 000 треков за одно действие; построчный ввод оставлен только как аварийный инструмент." : "The primary path syncs a connected account library. A local export file loads up to 10,000 tracks in one action; per-row entry remains an emergency tool only."}</p></div><Link className="button" href="/connections">{ru ? "Управлять аккаунтами" : "Manage accounts"}</Link></header>
      {error && <p className="notice danger" role="alert">{error}</p>}{message && <p className="notice success" role="status">{message}</p>}

      <section className="section card account-library" aria-labelledby="youtube-library-title">
        <div className="card-head"><div><p className="eyebrow">DIRECT ACCOUNT LIBRARY · OFFICIAL API</p><h2 id="youtube-library-title">YouTube / YouTube Music</h2><p className="muted">{ru ? "После Google OAuth здесь появляются все owned-плейлисты. Выберите нужные и синхронизируйте их целиком — названия, count и все videoId читаются автоматически." : "After Google OAuth, every owned playlist appears here. Select playlists and sync them in full; titles, counts, and every videoId are read automatically."}</p></div><span className={`badge ${youtubeConnection ? "verified" : "manual"}`}>{youtubeConnection ? "API CONNECTED" : "SETUP REQUIRED"}</span></div>
        {youtubeConnection && youtubeStatus === "CONNECTED" ? <>
          <div className="library-toolbar"><label className="field-label library-search"><span>{ru ? "Поиск по библиотеке" : "Search library"}</span><input type="search" value={youtubeQuery} onChange={(event) => setYoutubeQuery(event.target.value)} placeholder={ru ? "Название плейлиста" : "Playlist title"} /></label><div className="page-actions"><button className="button" type="button" onClick={() => void loadYoutube()}>{ru ? "Обновить список" : "Refresh list"}</button><button className="button" type="button" onClick={() => setYoutubeSelected(visibleYoutube.map((item) => item.id))}>{ru ? "Выбрать все" : "Select all"}</button><button className="button primary" type="button" disabled={!youtubeSelected.length || busy === "youtube-sync"} onClick={() => void snapshotYoutube(youtubeSelected)}>{busy === "youtube-sync" ? (ru ? "Синхронизация…" : "Syncing…") : (ru ? `Синхронизировать (${youtubeSelected.length})` : `Sync (${youtubeSelected.length})`)}</button></div></div>
          {visibleYoutube.length ? <div className="library-list">{visibleYoutube.map((item) => <div className={`library-row ${youtubeSelected.includes(item.id) ? "selected" : ""}`} key={item.id}><input aria-label={ru ? `Выбрать ${item.title}` : `Select ${item.title}`} type="checkbox" checked={youtubeSelected.includes(item.id)} onChange={(event) => setYoutubeSelected((current) => event.target.checked ? [...new Set([...current, item.id])] : current.filter((id) => id !== item.id))} /><span className="list-row-copy"><strong>{item.title}</strong><small>{item.itemCount} · {item.privacyStatus} · API_OWNED</small></span>{importedYoutubeIds.has(item.id) && <span className="badge verified">SYNCED</span>}<button className="button small-button" type="button" disabled={busy === "youtube-sync"} onClick={() => void snapshotYoutube([item.id])}>{ru ? "Обновить" : "Sync"}</button></div>)}</div> : <div className="empty-state"><div><h3>{ru ? "Плейлисты не найдены" : "No playlists found"}</h3><p>{ru ? "Сбросьте поиск или создайте owned-плейлист в YouTube." : "Clear the search or create an owned playlist in YouTube."}</p></div></div>}
        </> : <div className="empty-state"><div><span className="badge manual">{youtubeStatus}</span><h3>{ru ? "Подключите Google один раз" : "Connect Google once"}</h3><p>{ru ? "Нужен бесплатный собственный Google Cloud Desktop OAuth client. После подключения ручной ввод YouTube-треков не требуется." : "A free personal Google Cloud Desktop OAuth client is required. Once connected, no manual YouTube track entry is needed."}</p><Link className="button primary" href="/connections#youtube-direct">{ru ? "Настроить прямую синхронизацию" : "Set up direct sync"}</Link></div></div>}
      </section>

      <section className="section grid two">
        <article className="card"><p className="eyebrow">SPOTIFY · FREE BASELINE</p><h2>{ru ? "Без ложного «подключено»" : "No fake “connected” state"}</h2><p className="muted">{ru ? "Подтверждённая вкладка доказывает только выбранный профиль и не даёт приложению библиотеку. Spotify Web API Development Mode требует Premium у владельца OAuth app, поэтому прямой sync нельзя выдавать за бесплатную возможность." : "An attested tab proves only the selected profile and does not grant library access. Spotify Web API Development Mode requires Premium for the OAuth app owner, so direct sync cannot be represented as a free capability."}</p><span className="badge manual">BULK FILE FALLBACK</span></article>
        <article className="card"><p className="eyebrow">SOUNDCLOUD · EXTERNAL GATE</p><h2>{ru ? "Artist Pro не маскируется" : "Artist Pro is not hidden"}</h2><p className="muted">{ru ? "SoundCloud выдаёт self-service API credentials только с Artist Pro, а SC-BASE-LEGAL остаётся внешним gate. Библиотеку можно подготовить bulk-файлом, но transfer с SoundCloud по-прежнему остановится до provider mutation." : "SoundCloud grants self-service API credentials only with Artist Pro, and SC-BASE-LEGAL remains external. A bulk file can prepare the library, but a SoundCloud transfer still stops before provider mutation."}</p><span className="badge error">BLOCKED_EXTERNAL</span></article>
      </section>

      <section className="section card" aria-labelledby="bulk-import-title">
        <div className="card-head"><div><p className="eyebrow">ONE FILE · THOUSANDS OF TRACKS · LOCAL ONLY</p><h2 id="bulk-import-title">{ru ? "Массовый импорт плейлиста" : "Bulk playlist import"}</h2><p className="muted">{ru ? "Поддерживаются JSON (включая структуру Spotify Playlist export), CSV/TSV, M3U/M3U8 и TXT со ссылками. Файл читается в браузере и не отправляется в облако." : "Supports JSON (including Spotify Playlist export structure), CSV/TSV, M3U/M3U8, and URL-based TXT. The file is parsed in your browser and never sent to a cloud service."}</p></div>{bulkFileName && <span className="badge verified">{bulkFileName}</span>}</div>
        <form className="stack" onSubmit={(event) => void importBulk(event)}>
          {bulkProvider === "spotify" && <div className="notice export-guide"><div><strong>{ru ? "Получить официальный Spotify JSON" : "Get the official Spotify JSON"}</strong><p className="muted small">{ru ? "Откройте Account Privacy → Download your data → Account data. Spotify подготовит ZIP; загрузите ZIP сюда целиком — Playlist JSON будет найден автоматически." : "Open Account Privacy → Download your data → Account data. Spotify prepares a ZIP; upload the complete ZIP here and Playlist JSON is discovered automatically."}</p></div><a className="button" href="https://www.spotify.com/account/privacy/" target="_blank" rel="noreferrer">{ru ? "Открыть экспорт Spotify" : "Open Spotify export"}</a></div>}
          {bulkProvider === "youtube" && <div className="notice export-guide"><div><strong>{ru ? "Получить официальный Google Takeout" : "Get the official Google Takeout"}</strong><p className="muted small">{ru ? "Выберите YouTube and YouTube Music → playlists. Google обычно отдаёт плейлисты как CSV внутри ZIP; приложение понимает этот формат напрямую." : "Select YouTube and YouTube Music → playlists. Google usually exports playlists as CSV files inside a ZIP, which the app reads directly."}</p></div><a className="button" href="https://takeout.google.com/settings/takeout/custom/youtube" target="_blank" rel="noreferrer">{ru ? "Открыть Google Takeout" : "Open Google Takeout"}</a></div>}
          {bulkProvider === "soundcloud" && <p className="notice warning">{ru ? "SoundCloud позволяет запросить переносимую копию персональных данных через support, но официально не обещает полный playlist export. Поэтому приложение не выдаёт этот путь за совместимый JSON-import." : "SoundCloud lets users request a portable copy of personal data through support, but does not officially promise a complete playlist export. The app therefore does not represent it as a compatible JSON import."} <a href="https://help.soundcloud.com/hc/en-us/articles/360004066174-General-Data-Protection-Regulation-GDPR" target="_blank" rel="noreferrer">{ru ? "Официальная справка" : "Official help"}</a></p>}
          <div className="form-row"><label className="field-label"><span>{ru ? "Сервис" : "Provider"}</span><select value={bulkProvider} onChange={(event) => { const next = event.target.value as Provider; setBulkProvider(next); setBulkOptions([]); setBulkOptionKey(""); setBulkPlaylistUrl(""); setBulkOwner(connections.find((item) => item.provider === next)?.accountLabel ?? ""); }}><option value="spotify">Spotify</option><option value="soundcloud">SoundCloud</option><option value="youtube">YouTube / Music</option></select></label><label className="field-label file-picker"><span>{ru ? "ZIP-архив или файл экспорта" : "Export ZIP or file"}</span><input type="file" required accept=".zip,.json,.csv,.tsv,.m3u,.m3u8,.txt,application/zip,application/json,text/csv,text/plain" onChange={(event) => void readBulkFile(event)} /></label></div>
          {bulkOptions.length > 1 && <label className="field-label"><span>{ru ? "Плейлист из файла" : "Playlist from file"}</span><select value={bulkOptionKey} onChange={(event) => chooseBulkOption(event.target.value)}>{bulkOptions.map((option) => <option value={option.key} key={option.key}>{option.title} · {option.tracks.length}</option>)}</select></label>}
          {!bulkConnection && <p className="notice warning">{ru ? "Сначала сохраните identity этого аккаунта в «Подключениях». Это не будет показано как API-доступ." : "First save this account's identity under Connections. It will not be represented as API access."} <Link href="/connections">{ru ? "Открыть подключения" : "Open connections"}</Link></p>}
          {selectedBulk && <><div className="summary-strip"><div><small>{ru ? "Плейлист" : "Playlist"}</small><strong>{selectedBulk.title}</strong></div><div><small>{ru ? "Треков" : "Tracks"}</small><strong>{selectedBulk.tracks.length}</strong></div><div><small>{ru ? "Формат" : "Format"}</small><strong>{selectedBulk.format}</strong></div><div><small>{ru ? "Предупреждения" : "Warnings"}</small><strong>{selectedBulk.warnings.length}</strong></div></div>{selectedBulk.warnings.length > 0 && <div className="badge-row">{selectedBulk.warnings.map((warning) => <span className="badge manual" key={warning}>{warning}</span>)}</div>}<div className="form-row"><label className="field-label"><span>Official playlist share URL</span><input type="url" required value={bulkPlaylistUrl} onChange={(event) => setBulkPlaylistUrl(event.target.value)} placeholder={bulkProvider === "spotify" ? "https://open.spotify.com/playlist/…" : bulkProvider === "youtube" ? "https://www.youtube.com/playlist?list=…" : "https://soundcloud.com/user/sets/…"} /><small>{ru ? "Нужен один URL плейлиста, не URL каждой тысячи треков." : "One playlist URL is required—not a URL typed for every track."}</small></label><label className="field-label"><span>{ru ? "Аккаунт-владелец" : "Owner account"}</span><input required maxLength={100} value={bulkOwner} onChange={(event) => setBulkOwner(event.target.value)} /></label></div><label className="checkbox-row"><input type="checkbox" required checked={bulkAttested} onChange={(event) => setBulkAttested(event.target.checked)} /><span>{ru ? "Это мой плейлист: на официальной странице я вижу owner и edit/manage control. Это USER_ATTESTED_OWNED, не API verification." : "This is my playlist: I can see owner and edit/manage control on the official page. This is USER_ATTESTED_OWNED, not API verification."}</span></label><button className="button primary" type="submit" disabled={!bulkConnection || !bulkAttested || busy === "bulk-import"}>{busy === "bulk-import" ? (ru ? "Импорт…" : "Importing…") : (ru ? `Импортировать ${selectedBulk.tracks.length} треков` : `Import ${selectedBulk.tracks.length} tracks`)}</button></>}
        </form>
      </section>

      <section className="section"><div className="section-heading"><h2>{ru ? "Локальная библиотека" : "Local library"}</h2><p>{playlists.length}</p></div>{playlists.length ? <div className="grid three">{playlists.map((item) => <article className="card compact" key={item.id}><div className="card-head"><span className={`provider-icon ${item.provider}`}>{item.provider.slice(0, 2).toUpperCase()}</span><span className={`badge ${item.eligibility === "API_VERIFIED_OWNED" ? "verified" : "manual"}`}>{item.eligibility}</span></div><h3>{item.title}</h3><p className="muted small">{item.ownerLabel} · {item.itemCount} {ru ? "элементов" : "items"}</p>{item.partial && <p className="notice danger small">PARTIAL_COUNT_MISMATCH</p>}<a className="button small-button" href={item.providerUrl} target="_blank" rel="noreferrer">{ru ? "Открыть источник" : "Open source"}</a></article>)}</div> : <div className="empty-state"><div><h2>{ru ? "Локальная библиотека пуста" : "Local library is empty"}</h2><p>{ru ? "Подключите YouTube и выберите плейлисты выше либо импортируйте один bulk-файл." : "Connect YouTube and select playlists above, or import one bulk file."}</p></div></div>}</section>

      <details className="section advanced-panel"><summary>{ru ? "Аварийный ручной импорт и MV3 URL-draft" : "Emergency manual import and MV3 URL draft"}</summary><div className="stack advanced-content">
        <p className="notice warning">{ru ? "Этот раздел не является нормальным способом работы. Используйте его только для нестандартного файла или нескольких элементов." : "This is not the normal workflow. Use it only for an unusual file or a few items."}</p>
        {captures.length > 0 && <article className="card"><div className="card-head"><div><p className="eyebrow">MV3 URL DRAFT</p><h2>{captures.length}</h2></div><span className="badge manual">URL ONLY</span></div><div className="page-actions"><button className="button" type="button" onClick={addCapturedTrackLines}>{ru ? `Добавить URL (${capturedTracks.length})` : `Add URLs (${capturedTracks.length})`}</button><button className="button danger" type="button" onClick={() => { clearGuidedCaptureDraft(window.localStorage); setCaptures([]); }}>{ru ? "Удалить draft" : "Discard draft"}</button></div></article>}
        <article className="card"><form className="stack" onSubmit={(event) => void importManual(event)}><label className="field-label"><span>{ru ? "Сервис" : "Provider"}</span><select value={provider} onChange={(event) => setProvider(event.target.value as Provider)}><option value="spotify">Spotify</option><option value="soundcloud">SoundCloud</option><option value="youtube">YouTube / Music</option></select></label><label className="field-label"><span>Playlist share URL</span><input name="playlistUrl" type="url" value={playlistUrl} onChange={(event) => setPlaylistUrl(event.target.value)} required /></label><div className="form-row"><label className="field-label"><span>{ru ? "Название" : "Title"}</span><input name="title" required maxLength={300} /></label><label className="field-label"><span>{ru ? "Owner" : "Owner"}</span><input name="ownerLabel" required maxLength={100} /></label></div><input name="description" type="hidden" defaultValue="" /><label className="field-label"><span>{ru ? "Ожидаемое число элементов" : "Expected item count"}</span><input name="expectedCount" type="number" min="0" max="100000" required /></label><label className="field-label"><span>{ru ? "Строки: название | артист | секунды | URL" : "Rows: title | artist | seconds | URL"}</span><textarea name="tracks" required value={tracksText} onChange={(event) => setTracksText(event.target.value)} /></label><label className="checkbox-row"><input name="ownership" type="checkbox" required /><span>{ru ? "Owner совпадает с активным аккаунтом." : "Owner matches the active account."}</span></label><label className="checkbox-row"><input name="editControl" type="checkbox" required /><span>{ru ? "Edit/manage control виден." : "Edit/manage control is visible."}</span></label><button className="button" type="submit">{ru ? "Сохранить ручной snapshot" : "Save manual snapshot"}</button></form></article>
      </div></details>
    </>
  );
}
