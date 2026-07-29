import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "./components/app-shell";
import { LanguageProvider } from "./components/language-provider";
import { LocalSessionProvider } from "./components/local-session-provider";

export const metadata: Metadata = {
  title: {
    default: "Playlist-Transfer",
    template: "%s · Playlist-Transfer",
  },
  description:
    "Бесплатный local-first помощник для проверяемого переноса плейлистов.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body>
        <LanguageProvider>
          <LocalSessionProvider>
            <AppShell>{children}</AppShell>
          </LocalSessionProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
