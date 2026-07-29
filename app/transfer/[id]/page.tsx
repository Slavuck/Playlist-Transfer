import type { Metadata } from "next";
import { TransferDetailPage } from "../../components/transfer-detail-page";

export const metadata: Metadata = { title: "Статус переноса" };

export default async function TransferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TransferDetailPage transferId={id} />;
}
