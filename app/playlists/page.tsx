import type { Metadata } from "next";
import { PlaylistsPage } from "../components/playlists-page";
import { requireLocalPage } from "../local-only";

export const metadata: Metadata = { title: "Плейлисты" };
export default function Page() { requireLocalPage(); return <PlaylistsPage />; }
