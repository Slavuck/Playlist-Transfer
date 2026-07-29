import type { Metadata } from "next";
import { ReportPage } from "../../../components/report-page";

export const metadata: Metadata = { title: "Итоговый отчёт" };

export default async function TransferReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReportPage transferId={id} />;
}
