import type { Metadata } from "next";
import { ExtensionBridgePage } from "../components/extension-bridge-page";
import { requireLocalPage } from "../local-only";

export const metadata: Metadata = { title: "MV3 local bridge" };

export default function ExtensionBridgeRoute() { requireLocalPage(); return <ExtensionBridgePage />; }
