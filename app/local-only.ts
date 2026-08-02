import { redirect } from "next/navigation";

export function requireLocalPage(): void {
  if (process.env.PLAYLIST_TRANSFER_HOSTED === "1") redirect("/");
}
