"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Provider = "spotify" | "youtube";
type Account = { id: string; label: string; url?: string };
type Connection = { connected: boolean; account?: Account; reason?: string };
type Playlist = { id: string; provider: Provider; title: string; itemCount: number; ownerLabel: string; url: string; writable: boolean };
type Track = { id: string; title: string; artist: string; durationMs?: number; url: string };
type Candidate = { id: string; provider: Provider; title: string; artist: string; durationMs?: number; url: string; rank: number };
type Prepared = {
  source: { playlist: Playlist; tracks: Track[]; version: string };
  targetProvider: Provider;
  items: Array<{ source: Track; query: string; candidates: Candidate[] }>;
};
type TransferResult = {
  destination: { id: string; url: string; title: string; created: boolean };
  sourceCount: number;
  selectedCount: number;
  addedCount: number;
  failures: Array<{ id: string; error: string }>;
  verified: boolean;
};

const LABEL: Record<Provider, string> = { spotify: "Spotify", youtube: "YouTube Music" };

function other(provider: Provider): Provider {
  return provider === "spotify" ? "youtube" : "spotify";
}

function duration(value?: number): string {
  if (!value) return "—";
  const seconds = Math.round(value / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(payload.error || `HTTP_${response.status}`);
  return payload;
}

function ConnectionCard({ provider, connection, busy, onDisconnect }: {
  provider: Provider;
  connection: Connection;
  busy: boolean;
  onDisconnect: (provider: Provider) => void;
}) {
  return (
    <article className="card hosted-connection-card">
      <div className="card-head">
        <div>
          <div className={`provider-icon ${provider}`}>{provider === "spotify" ? "SP" : "YT"}</div>
          <h2>{LABEL[provider]}</h2>
        </div>
        <span className={`badge ${connection.connected ? "verified" : "manual"}`}>
          {connection.connected ? "подключено" : "не подключено"}
        </span>
      </div>
      {connection.connected ? (
        <>
          <p className="muted">Аккаунт: <strong>{connection.account?.label ?? "подключён"}</strong></p>
          <button className="button ghost" disabled={busy} onClick={() => onDisconnect(provider)}>Отключить</button>
        </>
      ) : (
        <>
          <p className="muted">Официальный OAuth. Пароль и cookie Spotify приложение не получает.</p>
          <a className="button primary" href={`/api/hosted/oauth/${provider}/start`}>Подключить {LABEL[provider]}</a>
        </>
      )}
    </article>
  );
}

export function HostedApp() {
  const [connections, setConnections] = useState<Record<Provider, Connection>>({ spotify: { connected: false }, youtube: { connected: false } });
  const [playlists, setPlaylists] = useState<Record<Provider, Playlist[]>>({ spotify: [], youtube: [] });
  const [sourceProvider, setSourceProvider] = useState<Provider>("youtube");
  const [sourcePlaylistId, setSourcePlaylistId] = useState("");
  const [destinationPlaylistId, setDestinationPlaylistId] = useState("");
  const [destinationTitle, setDestinationTitle] = useState("Codex 2");
  const [isPublic, setIsPublic] = useState(false);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [result, setResult] = useState<TransferResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("Проверяем подключения…");

  const targetProvider = other(sourceProvider);
  const bothConnected = connections.spotify.connected && connections.youtube.connected;

  const load = useCallback(async () => {
    try {
      const status = await api<{ connections: Record<Provider, Connection> }>("/api/hosted/status");
      setConnections(status.connections);
      const next: Record<Provider, Playlist[]> = { spotify: [], youtube: [] };
      for (const provider of ["spotify", "youtube"] as const) {
        if (status.connections[provider].connected) {
          const response = await api<{ playlists: Playlist[] }>(`/api/hosted/playlists?provider=${provider}`);
          next[provider] = response.playlists;
        }
      }
      setPlaylists(next);
      setMessage(status.connections.spotify.connected && status.connections.youtube.connected
        ? "Оба сервиса готовы к переносу."
        : "Подключите оба сервиса, чтобы начать перенос.");
    } catch (error) {
      setMessage(error instanceof Error ? `Ошибка: ${error.message}` : "Не удалось загрузить подключения.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => { void load(); });
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get("oauth");
    if (oauth && params.get("status") === "error") {
      queueMicrotask(() => setMessage(`OAuth ${oauth}: ${params.get("code") ?? "ошибка"}`));
    }
    if (oauth) window.history.replaceState({}, "", "/");
  }, []);

  const selectedCount = useMemo(() => Object.values(selections).filter(Boolean).length, [selections]);
  const unresolvedCount = prepared ? prepared.items.length - selectedCount : 0;

  function changeDirection() {
    const next = targetProvider;
    setSourceProvider(next);
    setPrepared(null);
    setSelections({});
    setResult(null);
    setReviewConfirmed(false);
    setSourcePlaylistId("");
    setDestinationPlaylistId("");
    setDestinationTitle(next === "spotify" ? "Codex 1" : "Codex 2");
  }

  async function disconnect(provider: Provider) {
    setBusy(true);
    try {
      await api(`/api/hosted/oauth/${provider}/disconnect`, { method: "POST", body: "{}" });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Не удалось отключить сервис.");
      setBusy(false);
    }
  }

  async function prepare() {
    if (!sourcePlaylistId) return;
    setBusy(true);
    setPrepared(null);
    setResult(null);
    setMessage("Ищем кандидатов в целевом сервисе…");
    try {
      const next = await api<Prepared>("/api/hosted/prepare", {
        method: "POST",
        body: JSON.stringify({ sourceProvider, sourcePlaylistId }),
      });
      const initial: Record<string, string> = {};
      if (sourceProvider === "youtube") {
        for (const item of next.items) if (item.candidates[0]) initial[item.source.id] = item.candidates[0].id;
      }
      setPrepared(next);
      setSelections(initial);
      setReviewConfirmed(false);
      setMessage(`Найдено позиций: ${next.items.length}. Проверьте соответствия перед записью.`);
    } catch (error) {
      setMessage(error instanceof Error ? `Подготовка: ${error.message}` : "Подготовка не удалась.");
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    if (!prepared || !selectedCount) return;
    setBusy(true);
    setResult(null);
    setMessage("Создаём плейлист, добавляем треки и проверяем чтением после записи…");
    try {
      const transfer = await api<TransferResult>("/api/hosted/execute", {
        method: "POST",
        body: JSON.stringify({
          sourceProvider,
          sourcePlaylistId,
          sourceVersion: prepared.source.version,
          destinationPlaylistId: destinationPlaylistId || undefined,
          destinationTitle: destinationPlaylistId ? undefined : destinationTitle,
          public: isPublic,
          selections: prepared.items.flatMap((item) => selections[item.source.id]
            ? [{ sourceId: item.source.id, targetId: selections[item.source.id] }]
            : []),
        }),
      });
      setResult(transfer);
      setMessage(transfer.verified
        ? `Готово: добавлено и проверено ${transfer.addedCount} из ${transfer.selectedCount}.`
        : `Запись завершена, но полная проверка не сошлась. Добавлено ${transfer.addedCount}; ошибок ${transfer.failures.length}.`);
      const response = await api<{ playlists: Playlist[] }>(`/api/hosted/playlists?provider=${targetProvider}`);
      setPlaylists((current) => ({ ...current, [targetProvider]: response.playlists }));
    } catch (error) {
      setMessage(error instanceof Error ? `Перенос: ${error.message}` : "Перенос не удался.");
    } finally {
      setBusy(false);
    }
  }

  const sourcePlaylists = playlists[sourceProvider];
  const destinationPlaylists = playlists[targetProvider].filter((playlist) => playlist.writable);
  const canExecute = Boolean(prepared && selectedCount && (destinationPlaylistId || destinationTitle.trim()) && (sourceProvider !== "spotify" || reviewConfirmed));

  return (
    <main className="hosted-page">
      <header className="hosted-hero">
        <div>
          <span className="eyebrow">Playlist-Transfer · hosted beta</span>
          <h1>Переносите плейлисты между Spotify и YouTube Music</h1>
          <p>Официальный вход, новая целевая подборка и проверка результата через API. SoundCloud пока намеренно отключён.</p>
        </div>
        <span className="honesty-badge"><span className="status-dot" /> Vercel Functions</span>
      </header>

      <p className={`notice ${result?.verified ? "success" : ""}`} role="status">{message}</p>

      <section className="grid two hosted-connections" aria-label="Подключения">
        <ConnectionCard provider="spotify" connection={connections.spotify} busy={busy} onDisconnect={disconnect} />
        <ConnectionCard provider="youtube" connection={connections.youtube} busy={busy} onDisconnect={disconnect} />
      </section>

      <section className="card hosted-transfer-card" data-disabled={!bothConnected}>
        <div className="section-heading">
          <div><span className="eyebrow">Новый перенос</span><h2>{LABEL[sourceProvider]} → {LABEL[targetProvider]}</h2></div>
          <button className="button ghost" disabled={busy} onClick={changeDirection}>Поменять направление</button>
        </div>
        <div className="form-row">
          <label className="field-label">Исходный плейлист
            <select value={sourcePlaylistId} disabled={!bothConnected || busy} onChange={(event) => setSourcePlaylistId(event.target.value)}>
              <option value="">Выберите плейлист</option>
              {sourcePlaylists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.title} · {playlist.itemCount}</option>)}
            </select>
          </label>
          <label className="field-label">Куда записать
            <select value={destinationPlaylistId} disabled={!bothConnected || busy} onChange={(event) => setDestinationPlaylistId(event.target.value)}>
              <option value="">Создать новый плейлист</option>
              {destinationPlaylists.map((playlist) => <option key={playlist.id} value={playlist.id}>Добавить в: {playlist.title} · {playlist.itemCount}</option>)}
            </select>
          </label>
        </div>
        {!destinationPlaylistId && (
          <div className="form-row hosted-destination-options">
            <label className="field-label">Название нового плейлиста
              <input value={destinationTitle} maxLength={100} disabled={busy} onChange={(event) => setDestinationTitle(event.target.value)} />
            </label>
            <label className="checkbox-row hosted-public-toggle">
              <input type="checkbox" checked={isPublic} disabled={busy} onChange={(event) => setIsPublic(event.target.checked)} />
              <span>Сделать плейлист публичным<br /><small className="muted">По умолчанию создаётся приватный.</small></span>
            </label>
          </div>
        )}
        <div className="hosted-action-row">
          <button className="button primary" disabled={!bothConnected || !sourcePlaylistId || busy} onClick={prepare}>{busy ? "Работаем…" : "Найти соответствия"}</button>
          <span className="muted small">До 100 треков за один перенос.</span>
        </div>
      </section>

      {prepared && (
        <section className="hosted-review">
          <div className="section-heading">
            <div><span className="eyebrow">Проверка кандидатов</span><h2>{prepared.source.playlist.title}</h2></div>
            <span className="badge gold">выбрано {selectedCount}/{prepared.items.length}</span>
          </div>
          {sourceProvider === "spotify" && <p className="notice warning">YouTube-кандидаты не выбираются автоматически. Сравните название и исполнителя, затем явно подтвердите результат.</p>}
          <div className="hosted-review-list">
            {prepared.items.map((item, index) => (
              <article className="card compact hosted-review-item" key={item.source.id}>
                <div className="hosted-source-track"><span className="badge">{index + 1}</span><div><strong>{item.source.title}</strong><small>{item.source.artist} · {duration(item.source.durationMs)}</small></div></div>
                {item.candidates.length ? (
                  <div className="hosted-candidates">
                    {item.candidates.slice(0, 3).map((candidate) => (
                      <label className={`hosted-candidate ${selections[item.source.id] === candidate.id ? "selected" : ""}`} key={candidate.id}>
                        <input type="radio" name={`candidate-${item.source.id}`} checked={selections[item.source.id] === candidate.id} onChange={() => setSelections((current) => ({ ...current, [item.source.id]: candidate.id }))} />
                        <span><strong>{candidate.title}</strong><small>{candidate.artist} · {duration(candidate.durationMs)}</small></span>
                        <a href={candidate.url} target="_blank" rel="noreferrer" aria-label="Открыть кандидата">↗</a>
                      </label>
                    ))}
                    <button className="button ghost small-button" onClick={() => setSelections((current) => ({ ...current, [item.source.id]: "" }))}>Пропустить</button>
                  </div>
                ) : <p className="notice warning">Кандидаты не найдены — позиция будет пропущена.</p>}
              </article>
            ))}
          </div>
          {sourceProvider === "spotify" && (
            <label className="checkbox-row hosted-review-confirmation">
              <input type="checkbox" checked={reviewConfirmed} onChange={(event) => setReviewConfirmed(event.target.checked)} />
              <span>Я проверил выбранные YouTube-видео и подтверждаю добавление.</span>
            </label>
          )}
          <div className="hosted-action-row">
            <button className="button primary" disabled={!canExecute || busy} onClick={execute}>Создать и проверить перенос</button>
            <span className="muted small">Выбрано: {selectedCount}; будет пропущено: {unresolvedCount}.</span>
          </div>
        </section>
      )}

      {result && (
        <section className={`card hosted-result ${result.verified ? "verified-result" : ""}`}>
          <span className={`badge ${result.verified ? "verified" : "error"}`}>{result.verified ? "проверено API" : "нужна проверка"}</span>
          <h2>{result.destination.title}</h2>
          <p>Добавлено {result.addedCount} из {result.selectedCount}; ошибок записи: {result.failures.length}.</p>
          <a className="button primary" href={result.destination.url} target="_blank" rel="noreferrer">Открыть плейлист</a>
        </section>
      )}

      <footer className="hosted-footer">
        <p>Токены хранятся только в зашифрованной HttpOnly-cookie этого браузера. Отключение YouTube также отзывает токен у Google.</p>
        <nav><a href="/privacy.html">Конфиденциальность</a><a href="/terms.html">Условия</a></nav>
      </footer>
    </main>
  );
}
