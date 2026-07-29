import type { Metadata } from "next";
import { ConnectionsPage } from "../components/connections-page";

export const metadata: Metadata = { title: "Подключения" };
export default function Page() { return <ConnectionsPage />; }
