import type { Metadata } from "next";
import { ConnectionsPage } from "../components/connections-page";
import { requireLocalPage } from "../local-only";

export const metadata: Metadata = { title: "Подключения" };
export default function Page() { requireLocalPage(); return <ConnectionsPage />; }
