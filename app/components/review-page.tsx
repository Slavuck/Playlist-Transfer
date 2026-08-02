"use client";

import Link from "next/link";
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useLanguage } from "./language-provider";
import { useLocalSession } from "./local-session-provider";
import { candidateEmbeddable, candidateTarget, displayProvider, formatDuration, normalizeTransferDetail, type ProviderTarget, type ReviewCandidate, type TransferDetail } from "./transfer-contract";

type Preview = { key: string; target: ProviderTarget; embeddable: boolean; label: string };

function targetUrl(target: ProviderTarget): string | undefined {
  return target.redactedDisplayUrl ?? target.attributionUrl ?? target.providerUriOrUrl;
}

function targetArtist(target: ProviderTarget): string {
  return target.artistRaw ?? target.uploaderRaw ?? target.channelRaw ?? "—";
}

function policyGatesDerivedScore(candidate?: ReviewCandidate): boolean {
  return candidate?.evidence?.some((entry) => entry.signal === "POLICY_GATE") === true;
}

function candidateValidationStatus(candidate?: ReviewCandidate): string {
  return candidate?.provenance?.validationStatus
    ?? candidate?.validation?.status
    ?? candidate?.candidate?.validation?.status
    ?? candidate?.validationStatus
    ?? "USER_SELECTED_UNVERIFIED";
}

function candidateHasProviderMetadata(candidate?: ReviewCandidate): boolean {
  return candidate?.provenance?.providerReadBack ?? candidateValidationStatus(candidate) === "PROVIDER_VALIDATED";
}

function CandidateProvenanceBadge({ candidate }: { candidate: ReviewCandidate }) {
  const status = candidateValidationStatus(candidate);
  if (status === "PROVIDER_VALIDATED") {
    const label = candidate.provenance?.source === "PROVIDER_OEMBED" ? "PROVIDER OEMBED" : "PROVIDER API";
    return <span className="badge verified">{label} · ID CONFIRMED</span>;
  }
  return <span className="badge manual">URL SYNTAX ONLY · UNVERIFIED</span>;
}

function CandidateProvenancePanel({ candidate, language }: { candidate: ReviewCandidate; language: "ru" | "en" }) {
  const ru = language === "ru";
  const provenance = candidate.provenance;
  const providerMetadata = candidateHasProviderMetadata(candidate);
  const fields = provenance?.metadataFields ?? [];
  return <div className={`notice ${providerMetadata ? "" : "warning"}`}>
    <p><strong>{ru ? "Происхождение:" : "Provenance:"}</strong> {providerMetadata
      ? provenance?.source === "PROVIDER_OEMBED" ? "official provider oEmbed" : "official provider API read-back"
      : ru ? "только разбор URL официального origin" : "official-origin URL syntax parsing only"}.</p>
    <p className="small muted">{providerMetadata
      ? `${ru ? "Provider подтвердил существование exact ID; поля metadata" : "The provider confirmed the exact ID; metadata fields"}: ${fields.join(", ") || (ru ? "не возвращены" : "none returned")}.`
      : ru
        ? "Exact ID извлечён из URL, но существование ID и metadata провайдером не подтверждены. Показанные URL/ID не являются provider validation."
        : "The exact ID was parsed from the URL, but provider existence and metadata were not confirmed. The displayed URL/ID is not provider validation."}</p>
    {provenance?.limitations?.length ? <div className="badge-row">{provenance.limitations.map((limitation) => <span className="badge manual" key={limitation}>{limitation}</span>)}</div> : null}
  </div>;
}

function OfficialYoutubePreview({ preview, language }: { preview: Preview; language: "ru" | "en" }) {
  const target = preview.target;
  const start = Math.max(0, Math.floor(((target.durationMs ?? 0) / 1_000) * 0.25));
  const ru = language === "ru";
  if (!target.videoId || !/^[A-Za-z0-9_-]{11}$/.test(target.videoId) || !preview.embeddable || !Number.isFinite(target.durationMs) || Number(target.durationMs) <= 0) {
    return <div className="player-fallback"><div><span className="badge manual">YOUTUBE LINK-OUT</span><h3>{ru ? "25% playback недоказуем" : "25% playback unavailable"}</h3><p className="muted">{ru ? "Длительность неизвестна/нулевая либо видео made-for-kids, region-blocked или запрещает embedding. Откройте его отдельно; это sequential fallback, без заявления о старте с 25%." : "Duration is unknown/zero, or the video is made-for-kids, region-blocked, or non-embeddable. Open it separately; this is a sequential fallback with no 25% start claim."}</p>{targetUrl(target) && <a className="button primary" href={targetUrl(target)} target="_blank" rel="noreferrer">{ru ? "Открыть YouTube" : "Open YouTube"}</a>}</div></div>;
  }
  return <div className="youtube-player"><iframe key={`${target.videoId}:${start}`} src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(target.videoId)}?autoplay=1&start=${start}&rel=0`} title={`${preview.label}: ${target.titleRaw ?? target.videoId}`} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /><p className="small muted">{ru ? `Официальный YouTube iframe стартует около 25% (${start} с) после вашего клика. Одновременно активен один player.` : `The official YouTube iframe starts near 25% (${start}s) after your click. Only one player is active.`}</p></div>;
}

function PlayerPanel({ preview, language, onClose }: { preview?: Preview; language: "ru" | "en"; onClose: () => void }) {
  const ru = language === "ru";
  if (!preview) return <div className="player-fallback"><div><span className="badge">USER GESTURE REQUIRED</span><h3>{ru ? "Выберите «Слушать с 25%»" : "Choose “Listen near 25%”"}</h3><p className="muted">{ru ? "Playback никогда не запускается автоматически при открытии очереди." : "Playback never starts automatically when the queue opens."}</p></div></div>;
  if (preview.target.provider === "youtube") return <div className="stack"><OfficialYoutubePreview preview={preview} language={language} /><button className="button small-button" type="button" onClick={onClose}>{ru ? "Остановить player" : "Stop player"}</button></div>;
  return <div className="player-fallback"><div><span className="badge manual">SEQUENTIAL / LINK-OUT</span><h3>{displayProvider(preview.target.provider)} · {preview.target.titleRaw}</h3><p className="muted">{ru ? "Бесплатного разрешённого strict side-by-side player нет. Ссылка открывается отдельно и не считается full comparison или стартом ровно с 25%." : "No free approved strict side-by-side player is available. The link opens separately and is not represented as full comparison or an exact 25% start."}</p>{targetUrl(preview.target) && <a className="button primary" href={targetUrl(preview.target)} target="_blank" rel="noreferrer">{ru ? "Открыть официальный трек" : "Open official track"}</a>}<button className="button small-button" type="button" onClick={onClose}>{ru ? "Закрыть fallback" : "Close fallback"}</button></div></div>;
}

export function ReviewPage({ transferId }: { transferId: string }) {
  const { language } = useLanguage();
  const { api } = useLocalSession();
  const ru = language === "ru";
  const [detail, setDetail] = useState<TransferDetail>();
  const [activeItem, setActiveItem] = useState(0);
  const [candidateSelection, setCandidateSelection] = useState<{ itemId: string; index: number }>({ itemId: "", index: 0 });
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => setDetail(normalizeTransferDetail(await api<unknown>(`/api/transfers/${encodeURIComponent(transferId)}`))), [api, transferId]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "REVIEW_LOAD_FAILED")); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const queue = useMemo(() => detail?.items.filter((item) => item.state === "NEEDS_REVIEW") ?? [], [detail]);
  const item = queue[Math.min(activeItem, Math.max(0, queue.length - 1))];
  const candidates = item?.candidates ?? [];
  const activeCandidate = candidateSelection.itemId === item?.id ? candidateSelection.index : 0;
  const selectedCandidate = candidates[Math.min(activeCandidate, Math.max(0, candidates.length - 1))];
  const selectedTarget = selectedCandidate ? candidateTarget(selectedCandidate) : undefined;
  const selectedHasProviderMetadata = candidateHasProviderMetadata(selectedCandidate);
  const selectedCanSeekYoutube = selectedTarget?.provider === "youtube"
    && selectedHasProviderMetadata
    && candidateEmbeddable(selectedCandidate ?? {})
    && Number.isFinite(selectedTarget.durationMs)
    && Number(selectedTarget.durationMs) > 0;
  const directSpotify = detail?.capabilities?.strategy === "api-with-guided-fallback"
    && detail.transfer.destinationProvider === "spotify";

  async function decide(action: "select" | "skip", target?: ProviderTarget, targetUrlInput?: string) {
    if (!item) return;
    setBusy(true); setError("");
    try {
      await api(`/api/transfers/${encodeURIComponent(transferId)}/review`, {
        method: "POST",
        body: JSON.stringify({ action, itemId: item.id, target, targetUrl: targetUrlInput }),
      });
      await load();
      setActiveItem((current) => Math.min(current, Math.max(0, queue.length - 2)));
      setPreview(undefined);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "REVIEW_DECISION_FAILED"); }
    finally { setBusy(false); }
  }

  async function selectManualUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await decide("select", undefined, String(form.get("targetUrl") ?? ""));
  }

  async function stageManualCandidates(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!item) return;
    const form = new FormData(event.currentTarget);
    const targets = String(form.get("candidateUrls") ?? "").split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
    setBusy(true); setError("");
    try {
      await api(`/api/transfers/${encodeURIComponent(transferId)}/review`, {
        method: "POST",
        body: JSON.stringify({ action: "stage-candidates", itemId: item.id, targets }),
      });
      await load();
      setCandidateSelection({ itemId: item.id, index: 0 });
      setPreview(undefined);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "CANDIDATE_STAGING_FAILED"); }
    finally { setBusy(false); }
  }

  async function autoMatch() {
    setBusy(true); setError("");
    try {
      const updated = await api<unknown>(`/api/transfers/${encodeURIComponent(transferId)}/review`, {
        method: "POST",
        body: JSON.stringify({ action: "auto-match" }),
      });
      setDetail(normalizeTransferDetail(updated));
      setActiveItem(0);
      setCandidateSelection({ itemId: "", index: 0 });
      setPreview(undefined);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "AUTOMATCH_FAILED"); }
    finally { setBusy(false); }
  }

  function candidateKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (!candidates.length) return;
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault(); nextIndex = (activeCandidate + 1) % candidates.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault(); nextIndex = (activeCandidate - 1 + candidates.length) % candidates.length;
    }
    if (nextIndex === undefined) return;
    setCandidateSelection({ itemId: item?.id ?? "", index: nextIndex });
    event.currentTarget.querySelectorAll<HTMLElement>("[role='tab']")[nextIndex]?.focus();
  }

  if (!detail) return <div className="empty-state"><div className="loading-pulse" aria-label={ru ? "Загрузка сверения" : "Loading review"} /></div>;
  if (!queue.length) return <div className="empty-state"><div><span className="badge verified">REVIEW COMPLETE</span><h1>{ru ? "Очередь разобрана" : "Review queue complete"}</h1><p>{ru ? "Все решения сохранены per item. Теперь можно создать неизменяемый write plan." : "Every decision is stored per item. The immutable write plan can now be created."}</p><Link className="button primary" href={`/transfer/${encodeURIComponent(transferId)}`}>{ru ? "Вернуться к переносу" : "Return to transfer"}</Link></div></div>;
  if (detail.transfer.destinationProvider === "spotify" && !directSpotify) {
    return <div className="empty-state"><div><span className="badge manual">SPOTIFY OAUTH REQUIRED</span><h1>{ru ? "Сначала подключите Spotify" : "Connect Spotify first"}</h1><p>{ru ? "Публичная ссылка на профиль не даёт приложению права искать и добавлять треки. Подключите Spotify один раз — после этого точные совпадения выберутся автоматически, а запись пойдёт прямо в ваш плейлист." : "A public profile URL cannot authorize search or playlist writes. Connect Spotify once, then confident matches are selected automatically and written directly to your playlist."}</p><div className="page-actions"><Link className="button primary" href="/connections">{ru ? "Подключить Spotify" : "Connect Spotify"}</Link><Link className="button" href={`/transfer/${encodeURIComponent(transferId)}`}>{ru ? "К статусу" : "Back to status"}</Link></div></div></div>;
  }

  const source = item.sourceRef ?? {};
  const sourcePreview: Preview = { key: `source:${item.id}`, target: source, embeddable: source.embeddable === true, label: ru ? "Оригинал" : "Original" };
  const candidatePreview: Preview | undefined = selectedTarget && selectedCandidate ? { key: `candidate:${item.id}:${activeCandidate}`, target: selectedTarget, embeddable: candidateEmbeddable(selectedCandidate), label: ru ? "Кандидат" : "Candidate" } : undefined;
  const visiblePreview = preview?.key.includes(item.id) ? preview : undefined;

  return (
    <>
      <header className="page-header"><div><p className="eyebrow">{directSpotify ? "AMBIGUOUS ONLY" : "PER-ITEM REVIEW"} · {queue.length} LEFT</p><h1 className="page-title">{directSpotify ? (ru ? "Только спорные совпадения" : "Ambiguous matches only") : (ru ? "Сверение кандидатов" : "Candidate review")}</h1><p className="page-subtitle">{directSpotify ? (ru ? "Очевидные совпадения приложение уже выбрало само. Здесь остаются только варианты, где есть реальный риск выбрать не ту запись или версию." : "Confident matches were already selected automatically. Only genuinely ambiguous recordings or versions remain here.") : (ru ? "Title, artist, version и duration evidence показаны отдельно. Ни популярность, ни provider rank сами по себе не подтверждают совпадение." : "Title, artist, version, and duration evidence are shown separately. Neither popularity nor provider rank proves a match.")}</p></div><div className="page-actions"><Link className="button" href={`/transfer/${encodeURIComponent(transferId)}`}>{ru ? "К статусу" : "Back to status"}</Link><span className="badge gold">{activeItem + 1} / {queue.length}</span></div></header>
      {error && <p className="notice danger" role="alert">{error}</p>}
      {directSpotify && <section className="section card callout-card"><div><p className="eyebrow">AUTOMATIC MATCHING</p><h2>{ru ? "Убрать очевидные совпадения" : "Resolve confident matches"}</h2><p className="muted">{ru ? "Повторный поиск проверит всю оставшуюся очередь. Совпадения без конфликтов исчезнут отсюда и будут готовы к переносу." : "A fresh search checks the remaining queue. Conflict-free matches leave this page and become ready to transfer."}</p></div><button className="button primary" type="button" disabled={busy} onClick={() => void autoMatch()}>{busy ? (ru ? "Сверяю…" : "Matching…") : (ru ? "Сверить автоматически" : "Match automatically")}</button></section>}
      {!directSpotify && <p className="notice warning"><strong>STRICT PLAYBACK GATE:</strong> {ru ? "рядом внутри приложения воспроизводится только разрешённый official YouTube iframe. Spotify/SoundCloud и запрещённые embeds используют явно помеченный sequential/link-out; это не full comparison." : "Only an allowed official YouTube iframe plays inside the app. Spotify/SoundCloud and blocked embeds use an explicitly labelled sequential/link-out fallback; this is not full comparison."}</p>}

      {!directSpotify && <section className="section card"><form className="stack" onSubmit={(event) => void stageManualCandidates(event)}><div><p className="eyebrow">GUIDED COMPARISON · 3–5 EXACT URL IDs</p><h2>{ru ? "Соберите несколько кандидатов" : "Collect several candidates"}</h2><p className="muted">{ru ? "Откройте официальный поиск и вставьте 3–5 разных share URL по одному на строку. Приложение всегда проверяет origin и синтаксис ID; существование и metadata подтверждены только при успешном provider read-back, что видно на каждом кандидате." : "Open the official search and paste 3–5 distinct share URLs, one per line. The app always checks origin and ID syntax; existence and metadata are confirmed only after a successful provider read-back, shown on every candidate."}</p></div>{item.searchUrl && <a className="button" href={item.searchUrl} target="_blank" rel="noreferrer">{ru ? `Искать на ${displayProvider(detail.transfer.destinationProvider)}` : `Search on ${displayProvider(detail.transfer.destinationProvider)}`}</a>}<label className="field-label"><span>{ru ? "3–5 URL официального origin" : "3–5 official-origin URLs"}</span><textarea name="candidateUrls" required rows={5} placeholder={"https://…\nhttps://…\nhttps://…"} /></label><button className="button" type="submit" disabled={busy}>{ru ? "Сохранить и показать provenance" : "Stage & show provenance"}</button></form></section>}

      <section className="section review-layout">
        <article className="card original-card"><div className="card-head"><div><p className="eyebrow">ORIGINAL · POSITION {item.sourcePosition + 1}</p><h2>{source.titleRaw ?? (ru ? "Без названия" : "Untitled")}</h2></div><span className={`provider-icon ${source.provider}`}>{source.provider?.slice(0, 2).toUpperCase()}</span></div><p className="muted">{targetArtist(source)} · {formatDuration(source.durationMs, language)}</p><div className="target-id"><small>{source.provider === "youtube" ? "videoId" : "providerEntityId"}</small><code>{source.videoId ?? source.providerEntityId ?? "—"}</code></div><div className="page-actions"><button className="button" type="button" onClick={() => setPreview(sourcePreview)}>{source.provider === "youtube" ? (ru ? "Слушать с 25%" : "Listen near 25%") : (ru ? "Sequential link-out" : "Sequential link-out")}</button>{targetUrl(source) && <a className="button small-button" href={targetUrl(source)} target="_blank" rel="noreferrer">{ru ? "Официальная ссылка" : "Official link"}</a>}</div>{Array.isArray(item.riskFlags) && item.riskFlags.length > 0 && <div className="badge-row">{item.riskFlags.map((flag) => <span className="badge manual" key={flag}>{flag}</span>)}</div>}</article>

        {visiblePreview && <article className="card"><div className="card-head"><div><p className="eyebrow">OFFICIAL PLAYER / HONEST FALLBACK</p><h2>{visiblePreview.label}</h2></div><span className="badge">ONE ACTIVE</span></div><PlayerPanel preview={visiblePreview} language={language} onClose={() => setPreview(undefined)} /></article>}

        <article className="card"><div className="card-head"><div><p className="eyebrow">EXACT DESTINATION URL IDs · PROVENANCE SHOWN</p><h2>{ru ? "Кандидаты" : "Candidates"}</h2></div><span className="badge">← →</span></div>
          {candidates.length ? <><div className="candidate-carousel" role="tablist" aria-label={ru ? "Кандидаты совпадения" : "Match candidates"} onKeyDown={candidateKeys}>{candidates.map((candidate, index) => {
            const target = candidateTarget(candidate);
            const selected = index === activeCandidate;
            const scoreGated = policyGatesDerivedScore(candidate);
            const providerMetadata = candidateHasProviderMetadata(candidate);
            return <button type="button" role="tab" aria-selected={selected} tabIndex={selected ? 0 : -1} className={`candidate-card ${selected ? "selected" : ""}`} key={`${target.providerEntityId ?? "candidate"}:${index}`} onClick={() => { setCandidateSelection({ itemId: item.id, index }); setPreview(undefined); }}><span className="badge">#{index + 1} · {scoreGated ? "MANUAL CHOICE" : candidate.score?.toFixed?.(1) ?? "—"}</span><strong>{providerMetadata ? target.titleRaw ?? target.providerEntityId ?? "—" : ru ? "Provider metadata не получены" : "Provider metadata unavailable"}</strong><small>{providerMetadata ? `${targetArtist(target)} · ${formatDuration(target.durationMs, language)}` : ru ? "Только URL/ID; существование не подтверждено" : "URL/ID only; existence not confirmed"}</small><code>{target.videoId ?? target.providerEntityId ?? "—"}</code><CandidateProvenanceBadge candidate={candidate} />{scoreGated ? <span className="badge manual">NO DERIVED SCORE</span> : candidate.conflicts?.length ? <span className="badge error">{candidate.conflicts.length} CONFLICT</span> : <span className="badge verified">NO HARD CONFLICT</span>}</button>;
          })}</div>
          {selectedCandidate && selectedTarget && <div className="candidate-detail">
            <div className="card-head"><div><h3>{selectedHasProviderMetadata ? selectedTarget.titleRaw : ru ? "Provider metadata не получены" : "Provider metadata unavailable"}</h3><p className="muted">{selectedHasProviderMetadata ? `${targetArtist(selectedTarget)} · ${formatDuration(selectedTarget.durationMs, language)}` : ru ? "Не подставлено название исходного трека" : "The source-track title was not substituted"}</p></div><strong className="score-value">{policyGatesDerivedScore(selectedCandidate) ? "MANUAL" : selectedCandidate.score?.toFixed?.(1) ?? "—"}</strong></div>
            {!directSpotify && <CandidateProvenancePanel candidate={selectedCandidate} language={language} />}
            {policyGatesDerivedScore(selectedCandidate) && <p className="notice warning">{ru ? "Provider policy gate: приложение не рассчитывает и не показывает cross-provider derived score. Сравните неизменённые provider metadata (если read-back успешен) и выберите exact ID сами." : "Provider policy gate: the app does not calculate or display a cross-provider derived score. Compare unmodified provider metadata (when read-back succeeded) and choose the exact ID yourself."}</p>}
            {!directSpotify && <div className="target-id"><small>{selectedTarget.provider === "youtube" ? "videoId (required)" : "providerEntityId"}</small><code>{selectedTarget.videoId ?? selectedTarget.providerEntityId ?? "—"}</code></div>}
            {!directSpotify && <div className="evidence-grid">{selectedCandidate.evidence?.map((evidence, index) => <div className="evidence-chip" key={`${evidence.signal}:${index}`}><span>{evidence.signal ?? "EVIDENCE"}</span><strong>{policyGatesDerivedScore(selectedCandidate) ? "—" : typeof evidence.points === "number" ? `${evidence.points >= 0 ? "+" : ""}${evidence.points}` : "—"}</strong><small>{evidence.detail}</small></div>)}</div>}
            {selectedCandidate.conflicts?.length ? <p className="notice warning">{selectedCandidate.conflicts.join(" · ")}</p> : null}
            <div className="page-actions"><button className="button" type="button" onClick={() => setPreview(candidatePreview)}>{selectedTarget.provider === "youtube" ? selectedCanSeekYoutube ? (ru ? "Слушать с 25%" : "Listen near 25%") : (ru ? "Открыть ссылку" : "Open link") : (ru ? "Открыть в Spotify" : "Open in Spotify")}</button><button className="button primary" type="button" disabled={busy || !selectedTarget.providerEntityId || (selectedTarget.provider === "youtube" && !selectedTarget.videoId)} onClick={() => void decide("select", selectedTarget)}>{directSpotify ? (ru ? "Выбрать совпадение" : "Choose match") : (ru ? "Выбрать этот точный ID" : "Select this exact ID")}</button></div>
          </div>}</> : <div className="empty-state"><div><h3>{ru ? "Кандидатов ещё нет" : "No candidates staged"}</h3><p>{ru ? "Вставьте URL официального origin ниже или пропустите трек. URL-only кандидат останется явно непроверенным." : "Paste an official-origin URL below or skip the track. A URL-only candidate remains explicitly unverified."}</p></div></div>}
        </article>

        <article className="card">{directSpotify ? <div className="callout-card"><div><p className="eyebrow">NO SAFE MATCH</p><h3>{ru ? "Ничего не подходит?" : "Nothing matches?"}</h3><p className="muted small">{ru ? "Пропустите трек — приложение не запишет случайную версию и отметит пропуск в отчёте." : "Skip the track—the app will not write a random version and will record the skip in the report."}</p></div><button className="button danger" type="button" disabled={busy} onClick={() => void decide("skip")}>{ru ? "Пропустить" : "Skip"}</button></div> : <div className="grid two"><form className="stack" onSubmit={(event) => void selectManualUrl(event)}><div><p className="eyebrow">GUIDED MANUAL CANDIDATE</p><h3>{ru ? "Вставить URL официального origin" : "Paste an official-origin target URL"}</h3><p className="muted small">{ru ? "Parser извлекает exact ID (для YouTube — 11-символьный videoId). Это не подтверждает существование или metadata само по себе. При настроенном YouTube API приложение отдельно делает videos.list read-back; иначе кандидат честно остаётся URL SYNTAX ONLY · UNVERIFIED." : "The parser extracts the exact ID (an 11-character videoId for YouTube). That alone does not confirm existence or metadata. With a configured YouTube API the app separately performs a videos.list read-back; otherwise the candidate remains URL SYNTAX ONLY · UNVERIFIED."}</p></div>{item.searchUrl && <a className="button" href={item.searchUrl} target="_blank" rel="noreferrer">{ru ? `Искать на ${displayProvider(detail.transfer.destinationProvider)}` : `Search on ${displayProvider(detail.transfer.destinationProvider)}`}</a>}<label className="field-label"><span>Official-origin share URL</span><input name="targetUrl" type="url" required placeholder="https://…" /></label><button className="button" type="submit" disabled={busy}>{ru ? "Выбрать с честным статусом" : "Select with honest status"}</button></form><div className="stack"><div><p className="eyebrow">NO MATCH</p><h3>{ru ? "Пропустить осознанно" : "Skip explicitly"}</h3><p className="muted small">{ru ? "Элемент станет SKIPPED_NOT_FOUND и останется в итоговом отчёте. Он не считается записанным." : "The item becomes SKIPPED_NOT_FOUND and remains in the final report. It is not counted as written."}</p></div><button className="button danger" type="button" disabled={busy} onClick={() => void decide("skip")}>{ru ? "Пропустить этот трек" : "Skip this track"}</button></div></div>}</article>
      </section>
    </>
  );
}
