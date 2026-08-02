import type { Metadata } from "next";
import { TransferDetailPage } from "../../components/transfer-detail-page";
import { requireLocalPage } from "../../local-only";

export const metadata: Metadata = { title: "Статус переноса" };

export default async function TransferPage({ params }: { params: Promise<{ id: string }> }) {
  requireLocalPage();
  const { id } = await params;
  return <TransferDetailPage transferId={id} />;
}
