"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLanguage } from "./language-provider";
import { useLocalSession } from "./local-session-provider";
import { displayProvider, honestBadge, normalizeTransferDetail, type Receipt, type TransferDetail } from "./transfer-contract";

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}

function receiptTarget(receipt: Receipt): Record<string, unknown> {
  const evidence = receipt.evidence ?? {};
  const domain = evidence.domainReceipt && typeof evidence.domainReceipt === "object" ? evidence.domainReceipt as Record<string, unknown> : {};
  return domain.target && typeof domain.target === "object" ? domain.target as Record<string, unknown> : {};
}

const countKeys = ["VERIFIED_PROVIDER", "USER_CONFIRMED_MANUAL", "UNVERIFIED", "ERROR", "SKIPPED", "IN_PROGRESS"] as const;

function reportNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function ReportPage({ transferId }: { transferId: string }) {
  const { language } = useLanguage();
  const { api } = useLocalSession();
  const ru = language === "ru";
  const [detail, setDetail] = useState<TransferDetail>();
  const [error, setError] = useState("");
  const load = useCallback(async () => setDetail(normalizeTransferDetail(await api<unknown>(`/api/transfers/${encodeURIComponent(transferId)}`))), [api, transferId]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "REPORT_LOAD_FAILED")); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const itemErrors = useMemo(() => detail?.items.filter((item) => ["WRITE_FAILED", "SKIPPED_NOT_FOUND"].includes(item.state)) ?? [], [detail]);

  const retained = useMemo(() => {
    const report = detail?.report ?? {};
    const rawCounts = report.counts && typeof report.counts === "object" ? report.counts as Record<string, unknown> : {};
    const counts = Object.fromEntries(countKeys.map((key) => [key, reportNumber(rawCounts[key]) ?? 0])) as Record<(typeof countKeys)[number], number>;
    const countTotal = countKeys.reduce((total, key) => total + counts[key], 0);
    return {
      counts,
      total: reportNumber(report.totalItems) ?? (countTotal > 0 ? countTotal : detail?.items.length ?? 0),
      successful: reportNumber(report.successful) ?? counts.VERIFIED_PROVIDER + counts.USER_CONFIRMED_MANUAL,
      rawDetailExpiredAtMs: reportNumber(report.rawDetailExpiredAtMs),
    };
  }, [detail]);

  if (!detail) return <div className="empty-state"><div className="loading-pulse" aria-label={ru ? "Загрузка отчёта" : "Loading report"} />{error && <p role="alert">{error}</p>}</div>;
  const transfer = detail.transfer;
  const reportedSuccess = retained.successful;
  const total = retained.total;

  return (
    <>
      <header className="page-header"><div><p className="eyebrow">FINAL LOCAL REPORT · {transfer.id}</p><h1 className="page-title">{ru ? "Фактический результат" : "Actual outcome"}</h1><p className="page-subtitle">{ru ? "Отчёт описывает наблюдаемое состояние, а не обещает атомарность. Provider verification, ручная аттестация и отсутствие проверки никогда не смешиваются." : "The report describes observed state rather than promising atomicity. Provider verification, manual attestation, and missing verification are never mixed."}</p></div><div className="page-actions"><Link className="button" href={`/transfer/${encodeURIComponent(transfer.id)}`}>{ru ? "К журналу" : "Back to journal"}</Link><button className="button primary" type="button" onClick={() => downloadJson(`playlist-transfer-report-${transfer.id}.json`, detail.report ?? { transfer, items: detail.items, receipts: detail.receipts })}>{ru ? "Экспорт JSON" : "Export JSON"}</button></div></header>
      {error && <p className="notice danger" role="alert">{error}</p>}
      {retained.rawDetailExpiredAtMs && <p className="notice warning" role="status"><strong>{ru ? "Срок хранения item-level evidence истёк." : "Item-level evidence retention expired."}</strong> {ru ? `Подробные items и receipts были удалены локально ${new Date(retained.rawDetailExpiredAtMs).toLocaleString(language)}. Итоговые числа ниже взяты из сохранённого retained summary; отсутствие строк больше не означает 0/0 или пустой перенос.` : `Detailed items and receipts were deleted locally on ${new Date(retained.rawDetailExpiredAtMs).toLocaleString(language)}. The totals below come from the retained summary; missing rows no longer mean 0/0 or an empty transfer.`}</p>}

      <section className="report-hero"><div><span className={`badge ${honestBadge(transfer.state)}`}>{transfer.state}</span><h2>{displayProvider(transfer.sourceProvider)} → {displayProvider(transfer.destinationProvider)}</h2><p>{transfer.mode} · {new Date(transfer.completedAtMs ?? transfer.updatedAtMs).toLocaleString(language)}</p></div><div className="report-ratio"><strong>{reportedSuccess}</strong><span>/ {total} {ru ? "подтверждено" : "confirmed"}</span></div></section>

      <section className="section report-counts" aria-label={ru ? "Категории результата" : "Outcome categories"}>
        <article className="report-count verified-count"><strong>{retained.counts.VERIFIED_PROVIDER}</strong><span>VERIFIED_PROVIDER</span><small>{ru ? "точный ID найден provider read-after-write" : "exact ID found by provider read-after-write"}</small></article>
        <article className="report-count manual-count"><strong>{retained.counts.USER_CONFIRMED_MANUAL}</strong><span>USER_CONFIRMED_MANUAL</span><small>{ru ? "только явная аттестация пользователя" : "explicit user attestation only"}</small></article>
        <article className="report-count error-count"><strong>{retained.counts.UNVERIFIED + retained.counts.ERROR + retained.counts.SKIPPED + retained.counts.IN_PROGRESS}</strong><span>{ru ? "Непроверено / ошибка" : "Unverified / error"}</span><small>{ru ? "не считается provider-verified успехом" : "not counted as provider-verified success"}</small></article>
      </section>

      <section className="section card"><div className="section-heading"><div><p className="eyebrow">WRITE RECEIPTS</p><h2>{ru ? "Результат по точным target IDs" : "Outcome by exact target ID"}</h2></div><span className="badge">{retained.rawDetailExpiredAtMs ? (ru ? "DETAIL EXPIRED" : "DETAIL EXPIRED") : detail.receipts.length}</span></div>{retained.rawDetailExpiredAtMs ? <div className="empty-state"><div><span className="badge manual">RETAINED SUMMARY</span><h3>{ru ? "Item-level квитанции удалены по retention policy" : "Item-level receipts were removed by retention policy"}</h3><p>{ru ? "Aggregate counts сохранены выше. Точные target IDs и evidence больше не доступны, поэтому интерфейс не реконструирует и не выдумывает их." : "Aggregate counts remain above. Exact target IDs and evidence are no longer available, so the interface does not reconstruct or invent them."}</p></div></div> : detail.receipts.length ? <div className="receipt-table" role="table" aria-label={ru ? "Квитанции записи" : "Write receipts"}>{detail.receipts.map((receipt) => {
        const target = receiptTarget(receipt);
        const exactId = String(target.videoId ?? target.providerEntityId ?? receipt.targetEntityId);
        return <div className="receipt-row" role="row" key={receipt.id}><div role="cell"><span className={`badge ${honestBadge(receipt.verificationStatus)}`}>{receipt.verificationStatus}</span></div><div role="cell"><small>{transfer.destinationProvider === "youtube" ? "videoId" : "target ID"}</small><code>{exactId}</code></div><div role="cell"><small>destination playlist ID</small><code>{receipt.destinationPlaylistId}</code></div><div role="cell"><small>{ru ? "Доказательство" : "Evidence"}</small><span>{receipt.verificationStatus === "VERIFIED_PROVIDER" ? (ru ? "независимый read-after-write" : "independent read-after-write") : receipt.verificationStatus === "USER_CONFIRMED_MANUAL" ? (ru ? "ручное подтверждение" : "manual confirmation") : (ru ? "нет достаточной проверки" : "insufficient verification")}</span></div></div>;
      })}</div> : <div className="empty-state"><div><h3>{ru ? "Квитанций нет" : "No receipts"}</h3><p>{ru ? "Ни одна запись не была подтверждена. Это не успех." : "No write was confirmed. This is not a success."}</p></div></div>}</section>

      {itemErrors.length > 0 && <section className="section card"><p className="eyebrow">SKIPPED / FAILED</p><h2>{ru ? "Не перенесённые элементы" : "Items not transferred"}</h2><div className="list">{itemErrors.map((item) => <div className="list-row" key={item.id}><div className="list-row-copy"><strong>{item.sourceRef.titleRaw ?? item.sourceRef.providerEntityId}</strong><small>{item.sourceRef.artistRaw ?? item.sourceRef.channelRaw} · position {item.sourcePosition + 1}</small></div><span className="badge error">{item.state}</span></div>)}</div></section>}

      <section className="section grid two"><article className="card"><p className="eyebrow">PROVIDER LIMITATIONS</p><h2>{ru ? "Что этот отчёт не гарантирует" : "What this report does not guarantee"}</h2><div className="stack"><p className="notice"><strong>YouTube / Music:</strong> {ru ? "каждая запись содержит точный 11-символьный videoId. Только статус VERIFIED_PROVIDER доказывает provider read-after-write; доступность видео в YouTube Music зависит от региона и каталога." : "every record contains an exact 11-character videoId. Only VERIFIED_PROVIDER proves provider read-after-write; availability in the YouTube Music UI depends on region and catalog."}</p><p className="notice"><strong>Spotify:</strong> {ru ? "guided write подтверждается пользователем и не становится provider verification." : "a guided write is user-confirmed and does not become provider verification."}</p><p className="notice warning"><strong>SoundCloud · SC-BASE-LEGAL:</strong> {ru ? "внешняя позиция остаётся неизвестной; наличие реализации не закрывает gate." : "the external position remains unknown; implementation does not close the gate."}</p></div></article><article className="card"><p className="eyebrow">STRICT GATE</p><h2>{ru ? "Sequential review ≠ full comparison" : "Sequential review ≠ full comparison"}</h2><p className="muted">{ru ? "Официальный YouTube iframe мог стартовать около 25%. Spotify/SoundCloud использовали link-out, если не было бесплатного письменного разрешения и official playback path. Строгий side-by-side gate поэтому остаётся внешне заблокированным для этих пар." : "An official YouTube iframe may have started near 25%. Spotify/SoundCloud used link-out without free written permission and an official playback path. The strict side-by-side gate therefore remains externally blocked for those pairs."}</p><div className="badge-row"><span className="badge verified">GUIDED BASELINE</span><span className="badge error">STRICT GATE ≠ CLAIMED</span></div></article></section>

      {transfer.limitationCodes?.length > 0 && <section className="section"><div className="badge-row">{transfer.limitationCodes.map((code) => <span className="badge manual" key={code}>{code}</span>)}</div></section>}
    </>
  );
}
