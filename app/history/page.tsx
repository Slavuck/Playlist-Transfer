import type { Metadata } from "next";
import { HistoryPage } from "../components/history-page";

export const metadata: Metadata = { title: "История" };

export default function HistoryRoute() { return <HistoryPage />; }
