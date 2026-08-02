import type { Metadata } from "next";
import { ReviewPage } from "../../../components/review-page";
import { requireLocalPage } from "../../../local-only";

export const metadata: Metadata = { title: "Сверение кандидатов" };

export default async function TransferReviewPage({ params }: { params: Promise<{ id: string }> }) {
  requireLocalPage();
  const { id } = await params;
  return <ReviewPage transferId={id} />;
}
