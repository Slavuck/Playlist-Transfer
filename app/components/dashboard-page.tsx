"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useLanguage } from "./language-provider";
import { useLocalSession } from "./local-session-provider";

type Summary = {
  connections: number;
  playlists: number;
  transfers: number;
  needsReview: number;
};

export function DashboardPage() {
  const { language } = useLanguage();
  const { api } = useLocalSession();
  const [summary, setSummary] = useState<Summary>({ connections: 0, playlists: 0, transfers: 0, needsReview: 0 });

  useEffect(() => {
    void Promise.all([
      api<unknown[]>("/api/connections"),
      api<unknown[]>("/api/playlists"),
      api<Array<{ state: string }>>("/api/transfers").catch(() => []),
    ]).then(([connections, playlists, transfers]) => setSummary({
      connections: connections.length,
      playlists: playlists.length,
      transfers: transfers.length,
      needsReview: transfers.filter((transfer) => transfer.state === "NEEDS_REVIEW").length,
    }));
  }, [api]);

  const ru = language === "ru";
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">GUIDED ZERO-BUDGET BASELINE</p>
          <h1 className="page-title">{ru ? "Перенос без чёрного ящика" : "Transfers without a black box"}</h1>
          <p className="page-subtitle">
            {ru
              ? "Каждый результат хранит точный ID формата провайдера; его существование подтверждено только при provider read-back. Ручная аттестация и независимая проверка не смешиваются. Данные и журнал живут на этом компьютере."
              : "Every result stores an exact provider-format ID; existence is confirmed only by provider read-back. Manual attestation and independent verification are never mixed. Data and the journal remain on this computer."}
          </p>
        </div>
        <div className="page-actions">
          <Link className="button primary" href="/transfer/new">{ru ? "Начать перенос" : "Start transfer"}</Link>
          <Link className="button" href="/playlists">{ru ? "Добавить источник" : "Add source"}</Link>
        </div>
      </header>

      <section className="grid four" aria-label={ru ? "Сводка" : "Summary"}>
        <article className="card compact metric"><strong className="metric-value">{summary.connections}/3</strong><span className="metric-label">{ru ? "подключённых сервисов" : "connected services"}</span></article>
        <article className="card compact metric"><strong className="metric-value">{summary.playlists}</strong><span className="metric-label">{ru ? "локальных снимков" : "local snapshots"}</span></article>
        <article className="card compact metric"><strong className="metric-value">{summary.transfers}</strong><span className="metric-label">{ru ? "переносов в журнале" : "journalled transfers"}</span></article>
        <article className="card compact metric"><strong className="metric-value">{summary.needsReview}</strong><span className="metric-label">{ru ? "ожидают сверения" : "awaiting review"}</span></article>
      </section>

      <section className="section">
        <div className="section-heading"><div><p className="eyebrow">ONE APP · THREE CONTROLS</p><h2>{ru ? "Точность задаётся на каждый перенос" : "Precision is set per transfer"}</h2></div></div>
        <div className="grid three">
          <article className="card"><span className="badge verified">SAFE</span><h3>{ru ? "Безопасный" : "Safe"}</h3><p className="muted">{ru ? "Там, где policy разрешает provider-validated auto-match, принимаются только сильные совпадения без конфликта версии и длительности; иначе используется guided review/skip." : "Where policy permits provider-validated auto-matching, only strong matches without duration or version conflicts are accepted; otherwise the app uses guided review/skip."}</p></article>
          <article className="card"><span className="badge manual">RISKY</span><h3>{ru ? "Рискованный" : "Risky"}</h3><p className="muted">{ru ? "Разрешённый auto-connector получает более широкий допуск и видимый risk flag. Режим не обходит policy gate и никогда не добавляет несвязанный первый результат." : "A permitted automatic connector gets a wider tolerance and a visible risk flag. The mode never bypasses a policy gate or adds an unrelated first result."}</p></article>
          <article className="card"><span className="badge">REVIEW</span><h3>{ru ? "Сверение" : "Review"}</h3><p className="muted">{ru ? "3–5 кандидатов, evidence и отдельное решение для каждого трека. Playback — только когда официально разрешён." : "3–5 candidates, evidence, and a per-item decision. Playback is used only where officially allowed."}</p></article>
        </div>
      </section>

      <section className="section grid two">
        <article className="card">
          <div className="card-head"><div><p className="eyebrow">HONEST STATUS</p><h2>{ru ? "Не все успехи одинаковы" : "Not all successes are equal"}</h2></div><span className="provider-icon">ID</span></div>
          <div className="list">
            <div className="list-row"><span><strong>VERIFIED_PROVIDER</strong><small>{ru ? "точный ID найден после записи" : "exact ID found after write"}</small></span><span className="badge verified">verified</span></div>
            <div className="list-row"><span><strong>USER_CONFIRMED_MANUAL</strong><small>{ru ? "только ваша аттестация" : "your attestation only"}</small></span><span className="badge manual">manual</span></div>
            <div className="list-row"><span><strong>WRITE_UNVERIFIED</strong><small>{ru ? "не считается успехом" : "not counted as success"}</small></span><span className="badge error">unverified</span></div>
          </div>
        </article>
        <article className="card">
          <div className="card-head"><div><p className="eyebrow">CURRENT EXTERNAL GATES</p><h2>{ru ? "Ограничения не спрятаны" : "Limitations stay visible"}</h2></div><span className="provider-icon">!</span></div>
          <div className="stack">
            <p className="notice warning"><strong>SoundCloud:</strong> {ru ? "базовая юридическая позиция для cross-service transfer не подтверждена; DOM/UI и конкурентный player выключены." : "the base legal position for cross-service transfer is unconfirmed; DOM/UI and competitive playback are disabled."}</p>
            <p className="notice"><strong>YouTube Music:</strong> {ru ? "в YouTube-плейлист записывается точный 11-символьный videoId; existence/write proof определяется отдельным статусом evidence, а видимость в Music не гарантируется." : "an exact 11-character videoId is written to a YouTube playlist; separate evidence status determines existence/write proof, and visibility in Music is not guaranteed."}</p>
            <p className="notice"><strong>Spotify:</strong> {ru ? "zero-budget путь — user-operated guided flow; Premium API не обязателен." : "the zero-budget path is a user-operated guided flow; Premium API access is not required."}</p>
          </div>
        </article>
      </section>
    </>
  );
}
