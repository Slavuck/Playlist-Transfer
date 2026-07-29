import type { Metadata } from "next";
import { ReviewPage } from "../../../components/review-page";

export const metadata: Metadata = { title: "Сверение кандидатов" };

export default async function TransferReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReviewPage transferId={id} />;
}
