"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "./language-provider";
import { useLocalSession } from "./local-session-provider";
import { displayProvider, honestBadge, type TransferRecord } from "./transfer-contract";

export function HistoryPage() {
  const { language } = useLanguage();
  const { api } = useLocalSession();
  const ru = language === "ru";
  const [transfers, setTransfers] = useState<TransferRecord[]>([]);
  const [filter, setFilter] = useState("ALL");
  const [error, setError] = useState("");
  useEffect(() => { void api<TransferRecord[]>("/api/transfers").then(setTransfers).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "HISTORY_LOAD_FAILED")); }, [api]);
  const visible = useMemo(() => filter === "ALL" ? transfers : transfers.filter((transfer) => filter === "ACTIVE" ? !["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(transfer.state) : transfer.state === filter), [filter, transfers]);
  return <>
    <header className="page-header"><div><p className="eyebrow">DURABLE LOCAL JOURNAL</p><h1 className="page-title">{ru ? "История" : "History"}</h1><p className="page-subtitle">{ru ? "Все переносы, review decisions и write receipts находятся в локальной SQLite. Никакой telemetry или облачной очереди." : "All transfers, review decisions, and write receipts live in local SQLite. No telemetry or cloud queue."}</p></div><Link className="button primary" href="/transfer/new">{ru ? "Новый перенос" : "New transfer"}</Link></header>
    {error && <p className="notice danger" role="alert">{error}</p>}
    <div className="choice-row" role="group" aria-label={ru ? "Фильтр истории" : "History filter"}>{["ALL", "ACTIVE", "NEEDS_REVIEW", "COMPLETED", "PARTIAL", "FAILED"].map((item) => <button type="button" className={`choice-chip ${filter === item ? "selected" : ""}`} onClick={() => setFilter(item)} key={item}>{item}</button>)}</div>
    <section className="section">{visible.length ? <div className="history-list">{visible.map((transfer) => <article className="history-row" key={transfer.id}><div className="history-direction"><span className={`provider-icon ${transfer.sourceProvider}`}>{transfer.sourceProvider.slice(0, 2).toUpperCase()}</span><span aria-hidden="true">→</span><span className={`provider-icon ${transfer.destinationProvider}`}>{transfer.destinationProvider.slice(0, 2).toUpperCase()}</span></div><div className="history-copy"><p className="eyebrow">{transfer.mode}</p><h2>{displayProvider(transfer.sourceProvider)} → {displayProvider(transfer.destinationProvider)}</h2><p>{new Date(transfer.updatedAtMs).toLocaleString(language)} · {transfer.selectedPlaylistIds.length} {ru ? "источников" : "sources"}</p><div className="badge-row"><span className={`badge ${honestBadge(transfer.state)}`}>{transfer.state}</span>{transfer.limitationCodes?.slice(0, 2).map((code) => <span className="badge manual" key={code}>{code}</span>)}</div></div><div className="history-actions">{transfer.state === "NEEDS_REVIEW" && <Link className="button small-button primary" href={`/transfer/${encodeURIComponent(transfer.id)}/review`}>Review</Link>}<Link className="button small-button" href={`/transfer/${encodeURIComponent(transfer.id)}`}>{ru ? "Открыть" : "Open"}</Link>{["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(transfer.state) && <Link className="button small-button" href={`/transfer/${encodeURIComponent(transfer.id)}/report`}>{ru ? "Отчёт" : "Report"}</Link>}</div></article>)}</div> : <div className="empty-state"><div><h2>{ru ? "Записей нет" : "No records"}</h2><p>{ru ? "Фильтр пуст или переносы ещё не запускались." : "The filter is empty or no transfers have been started."}</p></div></div>}</section>
  </>;
}
