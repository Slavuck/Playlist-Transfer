"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type Language = "ru" | "en";

const dictionary = {
  ru: {
    dashboard: "Главная",
    transfer: "Новый перенос",
    playlists: "Плейлисты",
    connections: "Подключения",
    history: "История",
    settings: "Данные и настройки",
    localOnly: "Только на этом устройстве",
    locked: "Локальный профиль заблокирован",
    createProfile: "Создать локальный профиль",
    unlock: "Разблокировать",
    displayName: "Имя профиля",
    passphrase: "Локальная парольная фраза",
    passphraseHint: "Не менее 10 символов. Она не отправляется провайдерам или в облако.",
    noProviderPasswords: "Никогда не вводите здесь пароль Spotify, SoundCloud или Google.",
    language: "Язык",
    status: "Статус",
    guided: "Guided / вручную",
    verified: "Проверено провайдером",
    manual: "Подтверждено пользователем",
    unverified: "Не проверено",
  },
  en: {
    dashboard: "Dashboard",
    transfer: "New transfer",
    playlists: "Playlists",
    connections: "Connections",
    history: "History",
    settings: "Data & settings",
    localOnly: "This device only",
    locked: "Local profile is locked",
    createProfile: "Create local profile",
    unlock: "Unlock",
    displayName: "Profile name",
    passphrase: "Local passphrase",
    passphraseHint: "At least 10 characters. It is never sent to providers or a cloud service.",
    noProviderPasswords: "Never enter a Spotify, SoundCloud, or Google password here.",
    language: "Language",
    status: "Status",
    guided: "Guided / manual",
    verified: "Provider verified",
    manual: "User confirmed",
    unverified: "Unverified",
  },
} as const;

type LanguageContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: keyof (typeof dictionary)["ru"]) => string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, updateLanguage] = useState<Language>("ru");

  useEffect(() => {
    const saved = window.localStorage.getItem("playlist-transfer-language");
    const timer = window.setTimeout(() => {
      if (saved === "en" || saved === "ru") updateLanguage(saved);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const setLanguage = useCallback((next: Language) => {
    updateLanguage(next);
    window.localStorage.setItem("playlist-transfer-language", next);
    document.documentElement.lang = next;
  }, []);

  const value = useMemo<LanguageContextValue>(() => ({
    language,
    setLanguage,
    t: (key) => dictionary[language][key],
  }), [language, setLanguage]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("LanguageProvider missing");
  return context;
}
