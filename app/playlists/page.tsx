import type { Metadata } from "next";
import { PlaylistsPage } from "../components/playlists-page";

export const metadata: Metadata = { title: "Плейлисты" };
export default function Page() { return <PlaylistsPage />; }
