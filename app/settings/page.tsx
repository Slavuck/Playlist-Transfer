import type { Metadata } from "next";
import { SettingsPage } from "../components/settings-page";
import { requireLocalPage } from "../local-only";

export const metadata: Metadata = { title: "Данные и настройки" };

export default function SettingsRoute() { requireLocalPage(); return <SettingsPage />; }
