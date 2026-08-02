"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useLanguage } from "./language-provider";
import { useLocalSession } from "./local-session-provider";
import { displayProvider, honestBadge, normalizeTransferDetail, type GuidedAction, type TransferDetail } from "./transfer-contract";

const terminalStates = new Set(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]);
const transferStages = ["DRAFT", "PREFLIGHT", "SNAPSHOTTING", "MATCHING", "NEEDS_REVIEW", "READY_TO_WRITE", "WRITING", "VERIFYING", "COMPLETED"];
const EXTENSION_CHANNEL = "playlist-transfer-extension-session-v1";

function actionUrl(action?: GuidedAction): string | undefined {
  return action?.officialUrl ?? action?.targetUrl ?? action?.destinationUrl;
}

function extensionNavigationTarget(action?: GuidedAction): Record<string, unknown> | undefined {
  if (action?.provider === "youtube" && action.videoId) return { provider: "youtube", action: "video", videoId: action.videoId };
  if (action?.provider === "spotify" && action.targetEntityId) return { provider: "spotify", action: "track", trackId: action.targetEntityId };
  const url = actionUrl(action);
  if (action?.provider === "soundcloud" && url) return { provider: "soundcloud", action: "permalink", url };
  return undefined;
}

function stageExtensionNavigation(target: Record<string, unknown>, correlationId: string): Promise<boolean> {
  if (typeof BroadcastChannel === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(EXTENSION_CHANNEL);
    const nonce = crypto.randomUUID();
    const timer = window.setTimeout(() => { channel.close(); resolve(false); }, 1_200);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: string; nonce?: string; ok?: boolean };
      if (data.type !== "NAVIGATION_STAGE_RESPONSE" || data.nonce !== nonce) return;
      window.clearTimeout(timer); channel.close(); resolve(data.ok === true);
    };
    channel.postMessage({ type: "NAVIGATION_STAGE_REQUEST", nonce, target, purpose: "MANUAL_ADD", correlationId });
  });
}

export function TransferDetailPage({ transferId }: { transferId: string }) {
  const { language } = useLanguage();
  const { api } = useLocalSession();
  const ru = language === "ru";
  const [detail, setDetail] = useState<TransferDetail>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [openedActionKey, setOpenedActionKey] = useState("");
  const [freshActionKey, setFreshActionKey] = useState("");
  const [extensionStagedActionKey, setExtensionStagedActionKey] = useState("");
  const [bindingAttested, setBindingAttested] = useState(false);

  const load = useCallback(async () => {
    const value = await api<unknown>(`/api/transfers/${encodeURIComponent(transferId)}`);
    setDetail(normalizeTransferDetail(value));
  }, [api, transferId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "TRANSFER_LOAD_FAILED")); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const transferState = detail?.transfer.state;
  useEffect(() => {
    if (!transferState || terminalStates.has(transferState)) return;
    const timer = window.setInterval(() => { void load().catch(() => undefined); }, 4_000);
    return () => window.clearInterval(timer);
  }, [load, transferState]);

  const counts = useMemo(() => {
    const items = detail?.items ?? [];
    const finished = items.filter((item) => ["VERIFIED_PROVIDER", "USER_CONFIRMED_MANUAL", "WRITE_CONFIRMED_NON_OWNED", "WRITE_UNVERIFIED", "WRITE_FAILED", "SKIPPED_NOT_FOUND", "SKIPPED_DUPLICATE", "WRITTEN"].includes(item.state)).length;
    const review = items.filter((item) => item.state === "NEEDS_REVIEW").length;
    return { total: detail?.progress?.total ?? items.length, finished: detail?.progress?.written ?? finished, review };
  }, [detail]);
  const percent = detail?.progress?.percent ?? (counts.total ? Math.round((counts.finished / counts.total) * 100) : 0);

  async function action(name: "start" | "run-next" | "run-all" | "cancel", body: Record<string, unknown> = {}) {
    setBusy(name); setError(""); setMessage("");
    try {
      await api(`/api/transfers/${encodeURIComponent(transferId)}/actions`, { method: "POST", body: JSON.stringify({ action: name, ...body }) });
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "TRANSFER_ACTION_FAILED"); }
    finally { setBusy(""); }
  }

  async function autoMatch() {
    setBusy("auto-match"); setError(""); setMessage("");
    try {
      await api(`/api/transfers/${encodeURIComponent(transferId)}/review`, { method: "POST", body: JSON.stringify({ action: "auto-match" }) });
      setMessage(ru ? "Очевидные совпадения выбраны автоматически. В очереди остались только неоднозначные треки." : "Confident matches were selected automatically. Only ambiguous tracks remain in review.");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "AUTOMATCH_FAILED"); }
    finally { setBusy(""); }
  }

  async function bindDestination(event: FormEvent<HTMLFormElement>, planKey: string) {
    event.preventDefault(); setBusy(`bind:${planKey}`); setError("");
    const form = new FormData(event.currentTarget);
    try {
      await api(`/api/transfers/${encodeURIComponent(transferId)}/actions`, {
        method: "POST",
        body: JSON.stringify({
          action: "bind-destination",
          planKey,
          playlistUrl: form.get("playlistUrl"),
          title: form.get("title"),
          ownershipAttested: bindingAttested,
          editControlAttested: bindingAttested,
          newPlaylistAttested: form.get("newPlaylistAttested") === "on",
          visibleItemCount: Number(form.get("visibleItemCount")),
        }),
      });
      setMessage(ru ? "ID нового пустого destination привязан к неизменяемому плану." : "The new empty destination ID is bound to the immutable plan.");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "DESTINATION_BIND_FAILED"); }
    finally { setBusy(""); }
  }

  async function reconcile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pending = detail?.actionCard;
    if (!pending?.transferItemId) return;
    const form = new FormData(event.currentTarget);
    const result = String(form.get("result") ?? "unknown") as "present" | "absent" | "unknown";
    setBusy("reconcile"); setError("");
    try {
      await api(`/api/transfers/${encodeURIComponent(transferId)}/actions`, {
        method: "POST",
        body: JSON.stringify({ action: "reconcile", itemId: pending.transferItemId, result }),
      });
      setMessage(result === "present" ? (ru ? "Сохранено как USER_CONFIRMED_MANUAL — это ваша аттестация, не provider verification." : "Saved as USER_CONFIRMED_MANUAL — your attestation, not provider verification.") : result === "absent" ? (ru ? "Отсутствие зафиксировано. Только теперь можно запросить новую action card." : "Absence recorded. Only now can a new action card be requested.") : (ru ? "Результат честно сохранён как непроверенный." : "The result was honestly saved as unverified."));
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "RECONCILIATION_FAILED"); }
    finally { setBusy(""); }
  }

  async function stagePendingNavigation() {
    const pending = detail?.actionCard;
    const target = extensionNavigationTarget(pending);
    if (!target || !pending?.transferItemId) return;
    const key = `${pending.actionId ?? "action"}:${pending.transferItemId}`;
    if (pending.requiresFreshDestinationConfirmation && freshActionKey !== key) {
      setError("FRESH_DESTINATION_CONFIRMATION_REQUIRED");
      return;
    }
    setBusy("extension-stage"); setError("");
    try {
      const staged = await stageExtensionNavigation(target, pending.transferItemId.slice(0, 64));
      if (!staged) throw new Error("PAIRED_EXTENSION_BRIDGE_NOT_AVAILABLE");
      setExtensionStagedActionKey(key);
      setMessage(ru ? "Навигация поставлена в очередь MV3. Откройте popup расширения и подтвердите переход." : "Navigation was staged in MV3. Open the extension popup and confirm the navigation.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "NAVIGATION_STAGE_FAILED"); }
    finally { setBusy(""); }
  }

  if (!detail) return <div className="empty-state"><div className="loading-pulse" aria-label={ru ? "Загрузка переноса" : "Loading transfer"} /></div>;
  const soundcloudManualOnly = detail.externalGate?.status === "MANUAL_ONLY";
  const transfer = detail.transfer;
  const stageIndex = transferStages.indexOf(transfer.state === "PARTIAL" ? "COMPLETED" : transfer.state);
  const pendingUrl = actionUrl(detail.actionCard);
  const actionKey = detail.actionCard ? `${detail.actionCard.actionId ?? "action"}:${detail.actionCard.transferItemId ?? "item"}` : "";
  const actionOpened = Boolean(actionKey && openedActionKey === actionKey);
  const freshnessConfirmed = !detail.actionCard?.requiresFreshDestinationConfirmation || freshActionKey === actionKey;
  const canCreateApiDestination = transfer.state === "NEEDS_REVIEW"
    && counts.review === 0
    && Boolean(detail.bindingNeeds?.length)
    && detail.capabilities?.strategy === "api-with-guided-fallback";
  const canRepairReadyState = transfer.state === "NEEDS_REVIEW" && counts.review === 0 && !detail.bindingNeeds?.length;
  const canRunNext = ((!detail.actionCard && !(detail.bindingNeeds?.length) && ["READY_TO_WRITE", "WRITING"].includes(transfer.state))
    || canCreateApiDestination || canRepairReadyState);

  return (
    <>
      <header className="page-header">
        <div><p className="eyebrow">TRANSFER · {transfer.id}</p><h1 className="page-title">{displayProvider(transfer.sourceProvider)} → {displayProvider(transfer.destinationProvider)}</h1><p className="page-subtitle">{ru ? "Состояние берётся из durable local journal. Обновление страницы или restart не повторяет provider mutation вслепую." : "State comes from the durable local journal. Reloading or restarting never blindly repeats a provider mutation."}</p></div>
        <div className="page-actions"><span className={`badge ${honestBadge(transfer.state)}`}>{transfer.state}</span>{terminalStates.has(transfer.state) && <Link className="button primary" href={`/transfer/${encodeURIComponent(transfer.id)}/report`}>{ru ? "Итоговый отчёт" : "Final report"}</Link>}</div>
      </header>
      {error && <p className="notice danger" role="alert">{error}</p>}
      {message && <p className="notice success" role="status">{message}</p>}
      {soundcloudManualOnly && <section className="section card callout-card"><div><p className="eyebrow">MANUAL ONLY · {detail.externalGate?.code}</p><h2>{ru ? "SoundCloud: перенос выполняете вы" : "SoundCloud: you operate the transfer"}</h2><p className="muted">{ru ? "Приложение не выполняет SoundCloud API/DOM-запись и не нажимает кнопки. Оно выдаёт по одному точному действию на официальной странице, ждёт вашей сверки destination и сохраняет результат только как USER_CONFIRMED_MANUAL." : "The app performs no SoundCloud API/DOM writes and clicks nothing. It emits one exact official-page action at a time, waits for your destination check, and records the result only as USER_CONFIRMED_MANUAL."}</p><p className="small muted">{detail.externalGate?.reason}</p></div><span className="badge manual">USER OPERATED</span></section>}
      {detail.bindingNeeds?.length ? <label className="checkbox-row notice warning"><input type="checkbox" checked={bindingAttested} onChange={(event) => setBindingAttested(event.target.checked)} /><span>{ru ? "Я вижу себя владельцем и проверил доступ edit/manage на официальной странице destination." : "I can see myself as owner and have checked edit/manage control on the official destination page."}</span></label> : null}
      {detail.bindingNeeds?.map((binding) => <div className="notice" key={`metadata:${binding.planKey}`}><strong>{ru ? "Метаданные для ручного создания:" : "Metadata for manual creation:"}</strong> {binding.title ?? "—"} · {binding.privacy ?? "provider-default"}{binding.description ? ` · ${binding.description}` : ""}{binding.copyCover ? (ru ? " · Обложка запрошена, но недоступна в local baseline." : " · Artwork was requested but is unavailable in the local baseline.") : ""}</div>)}

      <section className="card transfer-progress" aria-label={ru ? "Прогресс переноса" : "Transfer progress"}>
        <div className="card-head"><div><p className="eyebrow">DURABLE STATE</p><h2>{transfer.state}</h2></div><strong className="progress-number">{Math.max(0, Math.min(100, percent))}%</strong></div>
        <div className="progress-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><div className="progress-fill" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div>
        <div className="state-timeline">{transferStages.map((stage, index) => <span key={stage} className={index < stageIndex ? "done" : index === stageIndex ? "active" : ""}>{stage}</span>)}</div>
        <div className="summary-strip"><div><small>{ru ? "Всего" : "Total"}</small><strong>{counts.total}</strong></div><div><small>{ru ? "Завершено" : "Finished"}</small><strong>{counts.finished}</strong></div><div><small>Review</small><strong>{counts.review}</strong></div><div><small>{ru ? "Режим" : "Mode"}</small><strong>{transfer.mode}</strong></div></div>
      </section>

      {transfer.state === "DRAFT" && <section className="section card callout-card"><div><p className="eyebrow">NO PROVIDER MUTATION YET</p><h2>{ru ? "Запустить preflight и matching" : "Run preflight and matching"}</h2><p className="muted">{ru ? "Сначала проверяются snapshots, подключения, eligibility, лимиты и quota. Destination не создаётся при ошибке preflight." : "Snapshots, connections, eligibility, limits, and quota are checked first. No destination is created if preflight fails."}</p></div><button className="button primary" disabled={Boolean(busy)} onClick={() => void action("start")}>{busy === "start" ? (ru ? "Проверка…" : "Checking…") : (ru ? "Запустить безопасно" : "Start safely")}</button></section>}

      {transfer.state === "NEEDS_REVIEW" && counts.review > 0 && <section className="section card callout-card"><div><p className="eyebrow">MATCHING</p><h2>{ru ? `${counts.review} треков ещё не выбраны` : `${counts.review} tracks are not selected yet`}</h2><p className="muted">{detail.capabilities?.strategy === "api-with-guided-fallback" && transfer.destinationProvider === "spotify" ? (ru ? "Spotify подключён: приложение само выберет только точные совпадения по названию, артисту, версии и длительности. Неоднозначные варианты останутся для вашего решения." : "Spotify is connected: the app will select only confident matches by title, artist, version, and duration. Ambiguous options remain for you.") : (ru ? "Для автоматического поиска подключите официальный API сервиса назначения. Без него остаётся только ручная ссылка на точный трек." : "Connect the destination service's official API for automatic search. Without it, only manual exact-track links are available.")}</p></div><div className="page-actions">{detail.capabilities?.strategy === "api-with-guided-fallback" && transfer.destinationProvider === "spotify" && <button className="button primary" type="button" disabled={Boolean(busy)} onClick={() => void autoMatch()}>{busy === "auto-match" ? (ru ? "Сверяю…" : "Matching…") : (ru ? "Сверить автоматически" : "Match automatically")}</button>}<Link className="button" href={`/transfer/${encodeURIComponent(transfer.id)}/review`}>{ru ? "Проверить спорные" : "Review ambiguous"}</Link></div></section>}

      {detail.bindingNeeds?.map((binding) => <section className="section card" key={binding.planKey}><p className="eyebrow">GUIDED NEW-EMPTY DESTINATION BINDING</p><h2>{ru ? "Создайте новый пустой плейлист" : "Create a new empty playlist"}</h2><p className="notice warning">{ru ? "Для SEPARATE_COPY и MERGE_NEW нельзя выбирать или переиспользовать существующий playlist. Создайте новый destination для этого переноса и до привязки проверьте: видимый count равен 0." : "SEPARATE_COPY and MERGE_NEW cannot select or reuse an existing playlist. Create a new destination for this transfer and verify that its visible count is 0 before binding it."}</p>{binding.createUrl && <a className="button primary" href={binding.createUrl} target="_blank" rel="noreferrer">{ru ? `Открыть ${displayProvider(binding.provider)} и создать плейлист` : `Open ${displayProvider(binding.provider)} and create playlist`}</a>}<form className="stack" onSubmit={(event) => void bindDestination(event, binding.planKey)}><label className="field-label"><span>{ru ? "Название для сверки" : "Title for reconciliation"}</span><input name="title" defaultValue={binding.title ?? ""} required maxLength={300} /></label><label className="field-label"><span>Official playlist share URL</span><input name="playlistUrl" type="url" required placeholder="https://…" /></label><label className="field-label"><span>{ru ? "Видимый count на официальной странице" : "Visible count on the official page"}</span><input name="visibleItemCount" type="number" min="0" max="0" step="1" required placeholder="0" /></label><label className="checkbox-row"><input name="newPlaylistAttested" type="checkbox" required /><span>{ru ? "Я создал этот playlist сейчас для данного переноса; это не existing playlist, и до первой записи он содержит 0 элементов." : "I created this playlist now for this transfer; it is not an existing playlist, and it contains 0 items before the first write."}</span></label><button className="button primary" type="submit" disabled={Boolean(busy) || !bindingAttested}>{busy === `bind:${binding.planKey}` ? (ru ? "Проверка URL…" : "Validating URL…") : (ru ? "Привязать новый пустой playlist" : "Bind new empty playlist")}</button></form></section>)}

      {detail.actionCard?.transferItemId && <section className="section action-card" aria-labelledby="guided-action-title"><div className="action-sequence"><span className="action-step active">1</span><span className="action-line" /><span className={`action-step ${actionOpened ? "active" : ""}`}>2</span><span className="action-line" /><span className="action-step">3</span></div><p className="eyebrow">ONE GUIDED ACTION · NO AUTO-RETRY</p><h2 id="guided-action-title">{detail.actionCard.title ?? (ru ? "Добавьте один точный target ID" : "Add one exact target ID")}</h2><div className="target-identity"><span className={`provider-icon ${detail.actionCard.provider}`}>{detail.actionCard.provider?.slice(0, 2).toUpperCase()}</span><div><small>{detail.actionCard.provider === "youtube" ? "videoId" : "providerEntityId"}</small><strong>{detail.actionCard.videoId ?? detail.actionCard.targetEntityId ?? "—"}</strong><small>{ru ? "Назначение" : "Destination"}: {detail.actionCard.destinationPlaylistId ?? "—"}</small></div></div>{detail.actionCard.instructions?.length ? <ol className="clean-list">{detail.actionCard.instructions.map((instruction) => <li key={instruction}>{instruction}</li>)}</ol> : <p className="muted">{ru ? "Откройте официальный сайт, выполните одно добавление вручную и вернитесь для точной сверки." : "Open the official site, perform exactly one manual add, and return for explicit reconciliation."}</p>}
        {detail.actionCard.requiresFreshDestinationConfirmation && <label className="checkbox-row notice warning"><input type="checkbox" checked={freshnessConfirmed} onChange={(event) => setFreshActionKey(event.target.checked ? actionKey : "")} /><span>{detail.actionCard.expectedDestinationItemCount === undefined ? (ru ? "Я обновил официальную страницу, проверил именно этот destination и его текущий count; прежний baseline неоднозначен. При расхождении я не продолжаю." : "I refreshed the official page and checked this exact destination and its current count; the prior baseline is ambiguous. I will not continue on any mismatch.") : (ru ? `Я обновил официальный destination: текущий count равен ${detail.actionCard.expectedDestinationItemCount}, а exact target не конфликтует с выбранной collision policy.` : `I refreshed the official destination: the current count is ${detail.actionCard.expectedDestinationItemCount}, and the exact target does not conflict with the selected collision policy.`)}</span></label>}
        {pendingUrl && freshnessConfirmed ? <a className="button primary" href={pendingUrl} target="_blank" rel="noreferrer" onClick={() => setOpenedActionKey(actionKey)}>{ru ? "Открыть официальный сайт" : "Open official site"}</a> : <button className="button" type="button" disabled>{pendingUrl ? (ru ? "Сначала подтвердите свежий destination/count" : "Confirm the fresh destination/count first") : (ru ? "URL действия недоступен" : "Action URL unavailable")}</button>}
        {extensionNavigationTarget(detail.actionCard) && <button className="button" type="button" disabled={Boolean(busy) || !freshnessConfirmed} onClick={() => void stagePendingNavigation()}>{ru ? "Поставить переход в очередь MV3" : "Stage navigation in MV3"}</button>}
        {extensionStagedActionKey === actionKey && <label className="checkbox-row notice"><input type="checkbox" checked={actionOpened} onChange={(event) => setOpenedActionKey(event.target.checked ? actionKey : "")} /><span>{ru ? "Я подтвердил, что popup MV3 действительно открыл официальную страницу. Постановка в очередь сама по себе открытием не считается." : "I confirm that the MV3 popup actually opened the official page. Staging alone does not count as opening it."}</span></label>}
        <form className="reconcile-panel" onSubmit={(event) => void reconcile(event)}><fieldset className="plain-fieldset"><legend>{ru ? "После ручной проверки точного ID в destination" : "After manually checking the exact ID in the destination"}</legend><label className="radio-row"><input type="radio" name="result" value="present" required /><span><strong>{ru ? "Присутствует" : "Present"}</strong><small>{ru ? "Сохранить USER_CONFIRMED_MANUAL; это не независимая проверка." : "Save USER_CONFIRMED_MANUAL; this is not independent verification."}</small></span></label><label className="radio-row"><input type="radio" name="result" value="absent" required /><span><strong>{ru ? "Отсутствует" : "Absent"}</strong><small>{ru ? "Только этот ответ разрешает новую action card." : "Only this answer permits a new action card."}</small></span></label><label className="radio-row"><input type="radio" name="result" value="unknown" required /><span><strong>{ru ? "Не могу определить" : "Cannot determine"}</strong><small>{ru ? "Результат останется WRITE_UNVERIFIED и не считается успехом." : "The result remains WRITE_UNVERIFIED and is not counted as success."}</small></span></label></fieldset><button className="button primary" type="submit" disabled={busy === "reconcile" || !actionOpened || !freshnessConfirmed}>{ru ? (actionOpened ? "Сохранить reconciliation" : "Сначала откройте действие") : (actionOpened ? "Save reconciliation" : "Open the action first")}</button></form></section>}

      {canRunNext && <section className="section card callout-card"><div><p className="eyebrow">READY</p><h2>{detail.capabilities?.strategy === "api-with-guided-fallback" ? (ru ? "Перенести автоматически" : "Transfer automatically") : (ru ? "Продолжить ручной перенос" : "Continue manual transfer")}</h2><p className="muted">{detail.capabilities?.strategy === "api-with-guided-fallback" ? (ru ? "Все выбранные треки будут добавлены по очереди через подключённый коннектор (SpotAPI для Spotify или официальный API для YouTube) и проверены чтением плейлиста после записи." : "All selected tracks will be added sequentially through the connected provider connector (SpotAPI for Spotify or the official API for YouTube) and verified by reading the playlist after each write.") : (ru ? "Приложение выдаст одно точное действие и остановится до вашей проверки результата." : "The app will issue one exact action and stop for your result check.")}</p></div><button className="button primary" disabled={Boolean(busy)} onClick={() => void action(detail.capabilities?.strategy === "api-with-guided-fallback" ? "run-all" : "run-next")}>{busy === "run-all" || busy === "run-next" ? (ru ? "Перенос…" : "Transferring…") : detail.capabilities?.strategy === "api-with-guided-fallback" ? (ru ? "Перенести всё" : "Transfer all") : (ru ? "Следующий шаг" : "Next step")}</button></section>}

      {transfer.limitationCodes?.length > 0 && <section className="section card"><p className="eyebrow">PROVIDER LIMITATIONS</p><h2>{ru ? "Ограничения этого переноса" : "Limitations for this transfer"}</h2><div className="badge-row">{transfer.limitationCodes.map((code) => <span className="badge manual" key={code}>{code}</span>)}</div>{transfer.destinationProvider === "soundcloud" && <p className="notice warning"><strong>SC-BASE-LEGAL:</strong> {ru ? "внешний gate остаётся неизвестным; интерфейс не утверждает обратное." : "the external gate remains unknown; the interface does not claim otherwise."}</p>}</section>}

      {!terminalStates.has(transfer.state) && transfer.state !== "DRAFT" && <footer className="section danger-zone"><div><h2>{ru ? "Остановить выдачу новых шагов" : "Stop issuing new steps"}</h2><p className="muted">{ru ? "Текущий provider call завершится; уже выполненные изменения не откатываются автоматически." : "The current provider call may finish; completed changes are not automatically rolled back."}</p></div><button className="button danger" disabled={Boolean(busy)} onClick={() => { if (window.confirm(ru ? "Отменить перенос? Уже выполненные записи останутся у провайдера." : "Cancel the transfer? Completed writes remain at the provider.")) void action("cancel"); }}>{ru ? "Отменить перенос" : "Cancel transfer"}</button></footer>}
    </>
  );
}
