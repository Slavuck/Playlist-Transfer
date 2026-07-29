"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLanguage } from "./language-provider";
import { useLocalSession } from "./local-session-provider";
import { displayProvider, type PlaylistSnapshot, type Provider, type TransferMode } from "./transfer-contract";

const providers: Provider[] = ["spotify", "soundcloud", "youtube"];
const steps = ["SOURCE", "DESTINATION", "PRECISION", "CONFIRM"] as const;
type YoutubePlaylist = { id: string; title: string; itemCount: number; privacyStatus: string; ownership: string };

export function TransferWizardPage() {
  const { language } = useLanguage();
  const { api } = useLocalSession();
  const router = useRouter();
  const ru = language === "ru";
  const [snapshots, setSnapshots] = useState<PlaylistSnapshot[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [destinationProvider, setDestinationProvider] = useState<Provider>("youtube");
  const [mode, setMode] = useState<TransferMode>("SEPARATE_COPY");
  const [riskMode, setRiskMode] = useState<"SAFE" | "RISKY">("SAFE");
  const [reviewUncertain, setReviewUncertain] = useState(true);
  const [preserveDuplicates, setPreserveDuplicates] = useState(true);
  const [dedupe, setDedupe] = useState<"NONE" | "TARGET_ID" | "CONFIRMED_EQUIVALENCE">("NONE");
  const [privacy, setPrivacy] = useState<"PROVIDER_DEFAULT" | "PRIVATE" | "UNLISTED" | "PUBLIC">("PROVIDER_DEFAULT");
  const [unavailableItems, setUnavailableItems] = useState<"CONTINUE_AND_REPORT" | "STOP_BEFORE_WRITE">("CONTINUE_AND_REPORT");
  const [copyCover, setCopyCover] = useState(false);
  const [coverRights, setCoverRights] = useState(false);
  const [soundcloudSplit, setSoundcloudSplit] = useState(false);
  const [allowPartial, setAllowPartial] = useState(false);
  const [destinationTitle, setDestinationTitle] = useState("");
  const [destinationDescription, setDestinationDescription] = useState("");
  const [destinationUrl, setDestinationUrl] = useState("");
  const [destinationAttested, setDestinationAttested] = useState(false);
  const [existingItemCount, setExistingItemCount] = useState("0");
  const [existingItemIdsText, setExistingItemIdsText] = useState("");
  const [youtubeDestinations, setYoutubeDestinations] = useState<YoutubePlaylist[]>([]);
  const [youtubeDestinationId, setYoutubeDestinationId] = useState("");
  const [youtubeLibraryStatus, setYoutubeLibraryStatus] = useState("LOADING");
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void api<PlaylistSnapshot[]>("/api/playlists").then(setSnapshots).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "PLAYLISTS_LOAD_FAILED");
    });
    void api<YoutubePlaylist[]>("/api/youtube/playlists").then((items) => {
      setYoutubeDestinations(items);
      setYoutubeLibraryStatus("CONNECTED");
    }).catch((reason: unknown) => {
      setYoutubeDestinations([]);
      setYoutubeLibraryStatus(reason instanceof Error ? reason.message : "YOUTUBE_API_NOT_CONNECTED");
    });
  }, [api]);

  const selected = useMemo(() => snapshots.filter((snapshot) => selectedIds.includes(snapshot.id)), [selectedIds, snapshots]);
  const sourceProvider = selected[0]?.provider;
  const availableDestinationProviders = sourceProvider ? providers.filter((provider) => provider !== sourceProvider) : providers;
  const effectiveDestinationProvider = sourceProvider === destinationProvider ? (availableDestinationProviders[0] ?? "youtube") : destinationProvider;
  const itemCount = selected.reduce((total, snapshot) => total + snapshot.itemCount, 0);
  const hasPartial = selected.some((snapshot) => snapshot.partial);
  const selectedYoutubeDestination = youtubeDestinations.find((item) => item.id === youtubeDestinationId);

  function resetExistingDestination() {
    setYoutubeDestinationId("");
    setDestinationTitle("");
    setDestinationUrl("");
    setDestinationAttested(false);
    setExistingItemCount("0");
    setExistingItemIdsText("");
  }

  function chooseYoutubeDestination(id: string) {
    setYoutubeDestinationId(id);
    const playlist = youtubeDestinations.find((item) => item.id === id);
    if (!playlist) {
      resetExistingDestination();
      return;
    }
    setDestinationTitle(playlist.title);
    setDestinationUrl(`https://www.youtube.com/playlist?list=${playlist.id}`);
    setDestinationAttested(true);
    setExistingItemCount(String(playlist.itemCount));
    setExistingItemIdsText("");
  }

  function toggleSnapshot(snapshot: PlaylistSnapshot) {
    setError("");
    setSelectedIds((current) => {
      if (current.includes(snapshot.id)) return current.filter((id) => id !== snapshot.id);
      const currentProvider = snapshots.find((item) => current.includes(item.id))?.provider;
      if (currentProvider && currentProvider !== snapshot.provider) {
        setError(ru ? "В одном переносе источники должны относиться к одному сервису." : "Sources in one transfer must use the same provider.");
        return current;
      }
      return [...current, snapshot.id];
    });
  }

  function canAdvance(): boolean {
    if (step === 0) return selectedIds.length > 0;
    if (step === 1 && mode === "MERGE_NEW") return destinationTitle.trim().length > 0;
    if (step === 1 && mode === "APPEND_EXISTING") {
      const count = Number(existingItemCount);
      const ids = existingItemIdsText.split(/[\s,]+/).filter(Boolean);
      return destinationUrl.trim().length > 0 && destinationTitle.trim().length > 0 && destinationAttested
        && Number.isSafeInteger(count) && count >= ids.length && count >= 0;
    }
    if (step === 2 && copyCover) return coverRights;
    if (step === 3 && hasPartial) return allowPartial;
    return true;
  }

  function advance() {
    if (!canAdvance()) {
      setError(ru ? "Заполните обязательные поля этого шага." : "Complete the required fields on this step.");
      return;
    }
    setError("");
    setStep((current) => Math.min(steps.length - 1, current + 1));
  }

  async function createTransfer() {
    if (!sourceProvider || !canAdvance()) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ id?: string; transfer?: { id?: string } } | { id: string }>("/api/transfers", {
        method: "POST",
        body: JSON.stringify({
          sourceProvider,
          destinationProvider: effectiveDestinationProvider,
          mode,
          selectedPlaylistIds: selectedIds,
          allowPartial,
          settings: {
            matching: {
              riskMode,
              reviewUncertain,
              riskyRelevanceFallbackMinTitleSimilarity: 0.72,
              maxReviewCandidates: 5,
            },
            preserveDuplicates,
            preserveOrder: true,
            dedupe,
            unavailableItems,
            destinationPrivacy: privacy,
            privacyConfirmed: privacy !== "PROVIDER_DEFAULT",
            copyCover,
            coverRightsConfirmed: copyCover && coverRights,
            soundcloudOverflow: soundcloudSplit ? "SPLIT_WITH_CONFIRMATION" : "STOP",
          },
          destination: {
            title: mode === "SEPARATE_COPY" ? undefined : destinationTitle.trim(),
            description: destinationDescription.trim() || undefined,
            privacy: privacy === "PROVIDER_DEFAULT" ? undefined : privacy.toLowerCase(),
            playlistUrl: mode === "APPEND_EXISTING" ? destinationUrl.trim() : undefined,
            ownershipAttested: mode === "APPEND_EXISTING" ? destinationAttested : undefined,
            editControlAttested: mode === "APPEND_EXISTING" ? destinationAttested : undefined,
            existingItemCount: mode === "APPEND_EXISTING" ? Number(existingItemCount) : undefined,
            existingItemIds: mode === "APPEND_EXISTING" ? existingItemIdsText.split(/[\s,]+/).filter(Boolean) : undefined,
          },
        }),
      });
      const raw = result as { id?: string; transfer?: { id?: string } };
      const id = raw.id ?? raw.transfer?.id;
      if (!id) throw new Error("TRANSFER_ID_MISSING");
      router.push(`/transfer/${encodeURIComponent(id)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "TRANSFER_CREATE_FAILED");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">IMMUTABLE SETTINGS · LOCAL JOURNAL</p>
          <h1 className="page-title">{ru ? "Новый перенос" : "New transfer"}</h1>
          <p className="page-subtitle">{ru ? "Выберите реальные снимки, режим назначения и точность. До завершения сверения приложение ничего не записывает у провайдера." : "Choose real snapshots, a destination mode, and precision. Nothing is written to a provider before review is complete."}</p>
        </div>
      </header>

      <ol className="stepper" aria-label={ru ? "Шаги переноса" : "Transfer steps"}>
        {steps.map((item, index) => (
          <li key={item} className={`step-pill ${index === step ? "active" : index < step ? "done" : ""}`} aria-current={index === step ? "step" : undefined}>
            <span className="small">0{index + 1}</span>
            <strong>{ru ? ["Источники", "Назначение", "Точность", "Проверка"][index] : ["Sources", "Destination", "Precision", "Confirm"][index]}</strong>
          </li>
        ))}
      </ol>

      {error && <p className="notice danger" role="alert">{error}</p>}

      <section className="wizard-panel" aria-live="polite">
        {step === 0 && (
          <div className="stack">
            <div><p className="eyebrow">STEP 01</p><h2>{ru ? "Выберите один или несколько снимков" : "Select one or more snapshots"}</h2><p className="muted">{ru ? "Multi-select работает внутри одного source provider. Порядок снимков и повторов сохраняется." : "Multi-select works within one source provider. Snapshot order and duplicates are preserved."}</p></div>
            {snapshots.length ? <div className="selection-grid">{snapshots.map((snapshot) => {
              const checked = selectedIds.includes(snapshot.id);
              return (
                <label className={`selection-card ${checked ? "selected" : ""}`} key={snapshot.id}>
                  <input className="sr-only" type="checkbox" checked={checked} onChange={() => toggleSnapshot(snapshot)} />
                  <span className={`provider-icon ${snapshot.provider}`} aria-hidden="true">{snapshot.provider.slice(0, 2).toUpperCase()}</span>
                  <span><strong>{snapshot.title}</strong><small>{snapshot.itemCount} · {snapshot.ownerLabel}</small></span>
                  <span className={`badge ${snapshot.eligibility.includes("API_VERIFIED") ? "verified" : "manual"}`}>{snapshot.eligibility}</span>
                  {checked && <span className="badge gold">{ru ? "ПОРЯДОК" : "ORDER"} #{selectedIds.indexOf(snapshot.id) + 1}</span>}
                  {snapshot.partial && <span className="notice danger small">PARTIAL SNAPSHOT</span>}
                </label>
              );
            })}</div> : <div className="empty-state"><div><h2>{ru ? "Сначала добавьте снимок" : "Add a snapshot first"}</h2><p>{ru ? "Мастер принимает только owned/API-owned или явно аттестованные плейлисты." : "The wizard only accepts owned/API-owned or explicitly attested playlists."}</p><Link className="button primary" href="/playlists">{ru ? "Открыть снимки" : "Open snapshots"}</Link></div></div>}
          </div>
        )}

        {step === 1 && (
          <div className="stack">
            <div><p className="eyebrow">STEP 02</p><h2>{ru ? "Куда и как переносить" : "Where and how to transfer"}</h2></div>
            <fieldset className="plain-fieldset"><legend>{ru ? "Сервис назначения" : "Destination provider"}</legend><div className="choice-row">{availableDestinationProviders.map((provider) => <label className={`choice-chip ${effectiveDestinationProvider === provider ? "selected" : ""}`} key={provider}><input className="sr-only" type="radio" name="destinationProvider" checked={effectiveDestinationProvider === provider} onChange={() => { setDestinationProvider(provider); resetExistingDestination(); }} />{displayProvider(provider)}</label>)}</div></fieldset>
            <fieldset className="plain-fieldset"><legend>{ru ? "Режим назначения" : "Destination mode"}</legend><div className="grid three">
              {(["SEPARATE_COPY", "MERGE_NEW", "APPEND_EXISTING"] as TransferMode[]).map((item) => <label className={`mode-card ${mode === item ? "selected" : ""}`} key={item}><input className="sr-only" type="radio" name="mode" checked={mode === item} onChange={() => { setMode(item); resetExistingDestination(); }} /><strong>{ru ? ({ SEPARATE_COPY: "Отдельные копии", MERGE_NEW: "Один новый", APPEND_EXISTING: "Существующий" } as const)[item] : ({ SEPARATE_COPY: "Separate copies", MERGE_NEW: "One new playlist", APPEND_EXISTING: "Existing playlist" } as const)[item]}</strong><small>{ru ? ({ SEPARATE_COPY: "Один destination на каждый source", MERGE_NEW: "Объединить выбранные снимки", APPEND_EXISTING: "Только append; существующее не удаляется" } as const)[item] : ({ SEPARATE_COPY: "One destination per source", MERGE_NEW: "Merge selected snapshots", APPEND_EXISTING: "Append only; existing items stay" } as const)[item]}</small></label>)}
            </div></fieldset>
            {effectiveDestinationProvider === "youtube" && mode === "APPEND_EXISTING" && youtubeDestinations.length > 0 && <label className="field-label"><span>{ru ? "Мой YouTube-плейлист назначения" : "My YouTube destination playlist"}</span><select value={youtubeDestinationId} onChange={(event) => chooseYoutubeDestination(event.target.value)} required><option value="">{ru ? "Выберите плейлист из аккаунта" : "Select a playlist from your account"}</option>{youtubeDestinations.map((playlist) => <option value={playlist.id} key={playlist.id}>{playlist.title} · {playlist.itemCount} · {playlist.privacyStatus}</option>)}</select><small>{ru ? "Owner, URL и текущее содержимое проверяются официальным API во время preflight." : "Owner, URL, and current contents are verified through the official API during preflight."}</small></label>}
            {effectiveDestinationProvider === "youtube" && mode === "APPEND_EXISTING" && youtubeDestinations.length === 0 && <p className="notice warning">{ru ? `Библиотека YouTube недоступна (${youtubeLibraryStatus}). Можно использовать честный guided fallback ниже или подключить Google.` : `The YouTube library is unavailable (${youtubeLibraryStatus}). Use the honest guided fallback below or connect Google.`} <Link href="/connections#youtube-direct">{ru ? "Подключить" : "Connect"}</Link></p>}
            {effectiveDestinationProvider === "youtube" && mode !== "APPEND_EXISTING" && <p className="notice success">{ru ? "Новый YouTube-плейлист будет создан в подключённом аккаунте официальным API после preflight и подтверждения записи." : "A new YouTube playlist will be created in the connected account through the official API after preflight and write confirmation."}</p>}
            {selectedYoutubeDestination && <p className="notice success"><strong>API_OWNED:</strong> {selectedYoutubeDestination.title} · {selectedYoutubeDestination.itemCount} {ru ? "элементов" : "items"}</p>}
            {mode !== "SEPARATE_COPY" && !selectedYoutubeDestination && <div className="form-row"><label className="field-label"><span>{ru ? "Название назначения" : "Destination title"}</span><input value={destinationTitle} onChange={(event) => setDestinationTitle(event.target.value)} maxLength={300} required /></label>{mode === "APPEND_EXISTING" && <label className="field-label"><span>Playlist share URL</span><input type="url" value={destinationUrl} onChange={(event) => setDestinationUrl(event.target.value)} required placeholder="https://…" /></label>}</div>}
            {mode === "MERGE_NEW" && <label className="field-label"><span>{ru ? "Описание" : "Description"}</span><textarea value={destinationDescription} onChange={(event) => setDestinationDescription(event.target.value)} maxLength={5000} /></label>}
            {mode === "APPEND_EXISTING" && !selectedYoutubeDestination && <><label className="checkbox-row"><input type="checkbox" checked={destinationAttested} onChange={(event) => setDestinationAttested(event.target.checked)} /><span>{ru ? "Я вижу owner и edit/manage control на официальной странице. Это USER_ATTESTED_OWNED, если API не подтвердит права." : "I can see the owner and edit/manage control on the official page. This is USER_ATTESTED_OWNED unless the API verifies access."}</span></label><p className="notice warning">{ru ? "YouTube non-owned collaborative destination не входит в гарантированный baseline и не будет показан как provider-verified." : "A non-owned collaborative YouTube destination is outside the guaranteed baseline and will not be shown as provider-verified."}</p></>}
            {mode === "APPEND_EXISTING" && !selectedYoutubeDestination && <div className="grid two"><label className="field-label"><span>{ru ? "Текущее число элементов" : "Current destination item count"}</span><input type="number" min="0" step="1" value={existingItemCount} onChange={(event) => setExistingItemCount(event.target.value)} required /></label><label className="field-label"><span>{ru ? "Видимые provider IDs (необязательно)" : "Visible provider IDs (optional)"}</span><textarea value={existingItemIdsText} onChange={(event) => setExistingItemIdsText(event.target.value)} placeholder={ru ? "По одному ID на строку" : "One provider ID per line"} /><small>{ru ? "Для API-owned YouTube список перечитывается официальным API. В guided-режиме неполный список помечается ограничением." : "For API-owned YouTube this is refreshed through the official API. In guided mode, an incomplete list is recorded as a limitation."}</small></label></div>}
          </div>
        )}

        {step === 2 && (
          <div className="stack">
            <div><p className="eyebrow">STEP 03 · ONE APP, PER-TRANSFER CONTROLS</p><h2>{ru ? "Точность и политика записи" : "Precision and write policy"}</h2><p className="muted">{ru ? "SAFE/RISKY задаёт порог только для разрешённых provider-validated кандидатов. REVIEW — независимый переключатель: в guided/manual baseline uncertain-треки ждут вашего выбора, а при выключенном REVIEW честно пропускаются." : "SAFE/RISKY sets thresholds only for policy-permitted, provider-validated candidates. REVIEW is orthogonal: in the guided/manual baseline uncertain tracks await your choice, and with REVIEW off they are explicitly skipped."}</p></div>
            <fieldset className="plain-fieldset"><legend>{ru ? "Автоматический порог" : "Automatic threshold"}</legend><div className="grid two"><label className={`mode-card ${riskMode === "SAFE" ? "selected" : ""}`}><input className="sr-only" type="radio" checked={riskMode === "SAFE"} onChange={() => setRiskMode("SAFE")} /><span className="badge verified">SAFE</span><strong>{ru ? "Высокая точность" : "High precision"}</strong><small>{ru ? "Конфликт версии/длительности блокирует auto-match." : "Version or duration conflicts block auto-match."}</small></label><label className={`mode-card ${riskMode === "RISKY" ? "selected" : ""}`}><input className="sr-only" type="radio" checked={riskMode === "RISKY"} onChange={() => setRiskMode("RISKY")} /><span className="badge manual">RISKY</span><strong>{ru ? "Шире, но не вслепую" : "Wider, never blind"}</strong><small>{ru ? "Риск всегда видим; нерелевантный первый результат отклоняется." : "Risk stays visible; an unrelated first result is rejected."}</small></label></div></fieldset>
            <label className={`mode-card ${reviewUncertain ? "selected" : ""}`}><input type="checkbox" checked={reviewUncertain} onChange={(event) => setReviewUncertain(event.target.checked)} /><span className="badge">REVIEW</span><strong>{ru ? "Сверять uncertain-треки" : "Review uncertain tracks"}</strong><small>{ru ? "Показывать до 5 кандидатов с score, duration и version evidence; решение хранится per item." : "Show up to 5 candidates with score, duration and version evidence; decisions persist per item."}</small></label>
            {!reviewUncertain && <p className="notice warning">{ru ? "Без REVIEW guided URL-only кандидаты пропускаются и остаются в отчёте. RISKY не обходит provider policy gate и не подставляет первый результат; автоматический relevance fallback возможен только для разрешённого provider-validated connector." : "With REVIEW off, guided URL-only candidates are skipped and remain in the report. RISKY never bypasses a provider policy gate or substitutes the first result; an automatic relevance fallback is possible only for a permitted provider-validated connector."}</p>}
            <div className="grid two"><article className="card compact"><h3>{ru ? "Порядок и повторы" : "Order and duplicates"}</h3><label className="checkbox-row"><input type="checkbox" checked={preserveDuplicates} onChange={(event) => { setPreserveDuplicates(event.target.checked); if (event.target.checked) setDedupe("NONE"); }} /><span>{ru ? "Сохранять повторы" : "Preserve duplicates"}</span></label><label className="field-label"><span>Dedupe</span><select value={dedupe} onChange={(event) => { const next = event.target.value as typeof dedupe; setDedupe(next); if (next !== "NONE") setPreserveDuplicates(false); }}><option value="NONE">NONE</option><option value="TARGET_ID">TARGET_ID</option><option value="CONFIRMED_EQUIVALENCE">CONFIRMED_EQUIVALENCE</option></select></label></article><article className="card compact"><h3>{ru ? "Недоступные элементы" : "Unavailable items"}</h3><label className="field-label"><span>{ru ? "Действие" : "Behavior"}</span><select value={unavailableItems} onChange={(event) => setUnavailableItems(event.target.value as typeof unavailableItems)}><option value="CONTINUE_AND_REPORT">CONTINUE_AND_REPORT</option><option value="STOP_BEFORE_WRITE">STOP_BEFORE_WRITE</option></select></label><label className="field-label"><span>{ru ? "Приватность" : "Privacy"}</span><select value={privacy} onChange={(event) => setPrivacy(event.target.value as typeof privacy)}><option value="PROVIDER_DEFAULT">PROVIDER_DEFAULT</option><option value="PRIVATE">PRIVATE</option><option value="UNLISTED">UNLISTED</option><option value="PUBLIC">PUBLIC</option></select></label></article></div>
            <label className="checkbox-row"><input type="checkbox" checked={copyCover} onChange={(event) => setCopyCover(event.target.checked)} /><span>{ru ? "Попытаться скопировать обложку (best effort; бесплатно доступно не везде)" : "Attempt to copy artwork (best effort; not freely available everywhere)"}</span></label>
            {copyCover && <label className="checkbox-row"><input type="checkbox" checked={coverRights} onChange={(event) => setCoverRights(event.target.checked)} /><span>{ru ? "Я подтверждаю права на копирование этой обложки." : "I confirm I have the rights to copy this artwork."}</span></label>}
            {effectiveDestinationProvider === "soundcloud" && <label className="checkbox-row"><input type="checkbox" checked={soundcloudSplit} onChange={(event) => setSoundcloudSplit(event.target.checked)} /><span>{ru ? "При лимите 500 разрешить разбиение на части после подтверждения" : "Allow confirmed splitting when the 500-item limit is reached"}</span></label>}
          </div>
        )}

        {step === 3 && (
          <div className="stack">
            <div><p className="eyebrow">STEP 04 · PREFLIGHT BEFORE MUTATION</p><h2>{ru ? "Проверьте неизменяемые параметры" : "Review immutable parameters"}</h2></div>
            <div className="summary-strip"><div><small>{ru ? "Направление" : "Direction"}</small><strong>{displayProvider(sourceProvider)} → {displayProvider(effectiveDestinationProvider)}</strong></div><div><small>{ru ? "Источники" : "Sources"}</small><strong>{selected.length} · {itemCount} {ru ? "элементов" : "items"}</strong></div><div><small>{ru ? "Режим" : "Mode"}</small><strong>{mode}</strong></div><div><small>{ru ? "Точность" : "Precision"}</small><strong>{riskMode} · {reviewUncertain ? "REVIEW" : "NO REVIEW"}</strong></div></div>
            <div className="grid two"><article className="card compact"><h3>{ru ? "До записи" : "Before writing"}</h3><ul className="clean-list"><li>{ru ? "Проверка подключений, прав, лимитов и квоты" : "Connection, access, limit, and quota preflight"}</li><li>{ru ? "Зафиксированный snapshot и несколько hypotheses" : "A fixed snapshot and multiple hypotheses"}</li><li>{ru ? "Сверение завершено до write plan" : "Review completes before the write plan"}</li></ul></article><article className="card compact"><h3>{ru ? "Честный результат" : "Honest result"}</h3><ul className="clean-list"><li>VERIFIED_PROVIDER ≠ USER_CONFIRMED_MANUAL</li><li>{ru ? "Guided ambiguity требует reconciliation, без auto-retry" : "Guided ambiguity requires reconciliation, without auto-retry"}</li><li>{ru ? "Ошибки и внешние gates остаются в отчёте" : "Errors and external gates remain in the report"}</li></ul></article></div>
            {hasPartial && <label className={`mode-card ${allowPartial ? "selected" : ""}`}><input type="checkbox" checked={allowPartial} onChange={(event) => setAllowPartial(event.target.checked)} /><span className="badge error">PARTIAL SNAPSHOT</span><strong>{ru ? "Явно продолжить с неполным снимком" : "Explicitly continue with a partial snapshot"}</strong><small>{ru ? "Часть элементов отсутствует в snapshot. Они не будут найдены или записаны и останутся ограничением отчёта." : "Some items are absent from the snapshot. They cannot be matched or written and remain a report limitation."}</small></label>}
            {effectiveDestinationProvider === "soundcloud" && <p className="notice warning"><strong>SC-BASE-LEGAL:</strong> {ru ? "внешний gate не подтверждён. Реализация сохраняет user-operated путь, но не объявляет юридическое разрешение полученным." : "the external gate is unresolved. The implementation preserves the user-operated path without claiming legal approval."}</p>}
            <p className="notice">{ru ? "Создание переноса сохранит DRAFT локально. Отдельная кнопка запустит preflight; до неё никакой provider mutation нет." : "Creating the transfer saves a local DRAFT. A separate button starts preflight; no provider mutation happens before that."}</p>
          </div>
        )}

        <footer className="wizard-footer">
          <button className="button" type="button" disabled={step === 0 || busy} onClick={() => { setError(""); setStep((current) => Math.max(0, current - 1)); }}>{ru ? "Назад" : "Back"}</button>
          {step < steps.length - 1 ? <button className="button primary" type="button" disabled={!canAdvance()} onClick={advance}>{ru ? "Продолжить" : "Continue"}</button> : <button className="button primary" type="button" disabled={busy || !canAdvance()} onClick={() => void createTransfer()}>{busy ? (ru ? "Сохранение…" : "Saving…") : (ru ? "Создать локальный DRAFT" : "Create local DRAFT")}</button>}
        </footer>
      </section>
    </>
  );
}
