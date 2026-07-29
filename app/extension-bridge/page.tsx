import type { Metadata } from "next";
import { ExtensionBridgePage } from "../components/extension-bridge-page";

export const metadata: Metadata = { title: "MV3 local bridge" };

export default function ExtensionBridgeRoute() { return <ExtensionBridgePage />; }
