import type { Metadata } from "next";
import { HistoryPage } from "../components/history-page";
import { requireLocalPage } from "../local-only";

export const metadata: Metadata = { title: "История" };

export default function HistoryRoute() { requireLocalPage(); return <HistoryPage />; }
