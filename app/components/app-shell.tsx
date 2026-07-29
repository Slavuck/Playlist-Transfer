"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLanguage } from "./language-provider";
import { useLocalSession } from "./local-session-provider";

const nav = [
  { href: "/", key: "dashboard", icon: "01" },
  { href: "/transfer/new", key: "transfer", icon: "02" },
  { href: "/playlists", key: "playlists", icon: "03" },
  { href: "/connections", key: "connections", icon: "04" },
  { href: "/history", key: "history", icon: "05" },
  { href: "/settings", key: "settings", icon: "06" },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { language, setLanguage, t } = useLanguage();
  const { profile } = useLocalSession();
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">{language === "ru" ? "К содержимому" : "Skip to content"}</a>
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="Playlist-Transfer — главная">
          <span className="brand-mark" aria-hidden="true">PT</span>
          <span><strong>Playlist</strong><small>Transfer</small></span>
        </Link>
        <nav aria-label={language === "ru" ? "Основная навигация" : "Main navigation"}>
          {nav.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href} className={`nav-link ${active ? "active" : ""}`} aria-current={active ? "page" : undefined} aria-label={t(item.key)}>
                <span className="nav-index" aria-hidden="true">{item.icon}</span>
                <span>{t(item.key)}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="local-chip"><span className="status-dot" />{t("localOnly")}</div>
          <div className="profile-row">
            <span className="avatar" aria-hidden="true">{profile.profile?.displayName.slice(0, 2).toUpperCase()}</span>
            <span className="truncate">{profile.profile?.displayName}</span>
          </div>
          <div className="badge-row"><a className="small muted" href="/privacy.html">Privacy</a><a className="small muted" href="/terms.html">Terms</a></div>
        </div>
      </aside>
      <div className="work-area">
        <header className="topbar">
          <div>
            <span className="topbar-label">PERSONAL LOCAL TOOL</span>
          </div>
          <div className="topbar-actions">
            <span className="honesty-badge">{language === "ru" ? "Без телеметрии" : "No telemetry"}</span>
            <button className="language-toggle" type="button" onClick={() => setLanguage(language === "ru" ? "en" : "ru")} aria-label={language === "ru" ? "Switch to English" : "Переключить на русский"}>
              <span className={language === "ru" ? "selected" : ""}>RU</span><span>/</span><span className={language === "en" ? "selected" : ""}>EN</span>
            </button>
          </div>
        </header>
        <main id="main-content" className="page-content">{children}</main>
      </div>
    </div>
  );
}
