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
  const hosted = process.env.PLAYLIST_TRANSFER_HOSTED === "1";
  return (
    <html lang="ru">
      <body>
        {hosted ? children : (
          <LanguageProvider>
            <LocalSessionProvider>
              <AppShell>{children}</AppShell>
            </LocalSessionProvider>
          </LanguageProvider>
        )}
      </body>
    </html>
  );
}
