import { DashboardPage } from "./components/dashboard-page";
import { HostedApp } from "./components/hosted-app";

export default function Home() {
  return process.env.PLAYLIST_TRANSFER_HOSTED === "1" ? <HostedApp /> : <DashboardPage />;
}
