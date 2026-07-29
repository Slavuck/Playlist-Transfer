"use client";

import { createContext, FormEvent, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useLanguage } from "./language-provider";
import { scrubExtensionBridgeFragment } from "./extension-bridge-memory";

type PublicProfile = {
  exists: boolean;
  unlocked: boolean;
  profile?: { id: string; displayName: string; language: "ru" | "en"; createdAtMs: number };
};

type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; retryable: boolean } };

type SessionContextValue = {
  csrf: string;
  profile: PublicProfile;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  refreshProfile: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

async function readEnvelope<T>(response: Response): Promise<T> {
  const envelope = (await response.json()) as ApiEnvelope<T>;
  if (!envelope.ok) throw new Error(envelope.error.code);
  return envelope.data;
}

export function LocalSessionProvider({ children }: { children: React.ReactNode }) {
  const { language, setLanguage, t } = useLanguage();
  const [csrf, setCsrf] = useState("");
  const [profile, setProfile] = useState<PublicProfile>();
  const [fatalError, setFatalError] = useState("");
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    scrubExtensionBridgeFragment();
  }, []);

  const bootstrap = useCallback(async () => {
    const session = await readEnvelope<{ csrf: string }>(await fetch("/api/session", { cache: "no-store", credentials: "same-origin" }));
    setCsrf(session.csrf);
    const nextProfile = await readEnvelope<PublicProfile>(await fetch("/api/profile", { cache: "no-store", credentials: "same-origin", headers: { "x-playlist-transfer-nonce": session.csrf } }));
    setProfile(nextProfile);
    if (nextProfile.profile?.language) setLanguage(nextProfile.profile.language);
  }, [setLanguage]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void bootstrap().catch((reason: unknown) => setFatalError(reason instanceof Error ? reason.message : "BOOTSTRAP_FAILED"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [bootstrap]);

  const api = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    headers.set("x-playlist-transfer-nonce", csrf);
    if ((init.method ?? "GET").toUpperCase() !== "GET") headers.set("x-playlist-transfer-csrf", csrf);
    const response = await fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store" });
    return readEnvelope<T>(response);
  }, [csrf]);

  const refreshProfile = useCallback(async () => {
    const next = await api<PublicProfile>("/api/profile");
    setProfile(next);
  }, [api]);

  const value = useMemo<SessionContextValue | null>(() => profile && csrf ? { csrf, profile, api, refreshProfile } : null, [api, csrf, profile, refreshProfile]);

  if (fatalError) {
    return (
      <main className="profile-gate">
        <section className="gate-card" role="alert">
          <p className="eyebrow">LOCAL LOOPBACK ERROR</p>
          <h1>Playlist-Transfer</h1>
          <p>{fatalError}</p>
          <button className="button primary" onClick={() => window.location.reload()}>Повторить</button>
        </section>
      </main>
    );
  }

  if (!profile || !csrf) return <main className="profile-gate"><div className="loading-pulse" aria-label="Загрузка локального профиля" /></main>;

  if (!profile.exists || !profile.unlocked) {
    return (
      <ProfileGate
        exists={profile.exists}
        language={language}
        labels={{ locked: t("locked"), create: t("createProfile"), unlock: t("unlock"), name: t("displayName"), passphrase: t("passphrase"), hint: t("passphraseHint"), warning: t("noProviderPasswords") }}
        error={actionError}
        onSubmit={async (event) => {
          event.preventDefault();
          setActionError("");
          const form = new FormData(event.currentTarget);
          const payload = profile.exists
            ? { action: "unlock", passphrase: String(form.get("passphrase") ?? "") }
            : { action: "create", displayName: String(form.get("displayName") ?? ""), passphrase: String(form.get("passphrase") ?? ""), language };
          try {
            const next = await api<PublicProfile>("/api/profile", { method: "POST", body: JSON.stringify(payload) });
            setProfile(next);
          } catch (reason) {
            setActionError(reason instanceof Error ? reason.message : "PROFILE_ACTION_FAILED");
          }
        }}
      />
    );
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

function ProfileGate({
  exists,
  language,
  labels,
  error,
  onSubmit,
}: {
  exists: boolean;
  language: "ru" | "en";
  labels: { locked: string; create: string; unlock: string; name: string; passphrase: string; hint: string; warning: string };
  error: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
}) {
  return (
    <main className="profile-gate">
      <section className="gate-card">
        <div className="brand-mark" aria-hidden="true">PA</div>
        <p className="eyebrow">LOCAL-FIRST · ZERO-BUDGET</p>
        <h1>{exists ? labels.locked : labels.create}</h1>
        <p className="gate-copy">
          {language === "ru"
            ? "Профиль и журнал хранятся в SQLite на этом компьютере. Ключ шифрования существует только в памяти после разблокировки."
            : "Your profile and journal stay in SQLite on this computer. The encryption key exists only in memory after unlock."}
        </p>
        <form className="stack" onSubmit={onSubmit}>
          {error && <p className="notice danger" role="alert">{error}</p>}
          {!exists && (
            <label className="field-label">
              <span>{labels.name}</span>
              <input name="displayName" required maxLength={80} autoComplete="nickname" />
            </label>
          )}
          <label className="field-label">
            <span>{labels.passphrase}</span>
            <input name="passphrase" type="password" required minLength={exists ? 1 : 10} maxLength={512} autoComplete={exists ? "current-password" : "new-password"} />
            <small>{labels.hint}</small>
          </label>
          <p className="notice warning">{labels.warning}</p>
          <button className="button primary" type="submit">{exists ? labels.unlock : labels.create}</button>
        </form>
      </section>
    </main>
  );
}

export function useLocalSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error("LocalSessionProvider missing or profile locked");
  return context;
}
