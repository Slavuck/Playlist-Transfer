import type { Metadata } from "next";
import { TransferWizardPage } from "../../components/transfer-wizard-page";
import { requireLocalPage } from "../../local-only";

export const metadata: Metadata = { title: "Новый перенос" };

export default function NewTransferPage() {
  requireLocalPage();
  return <TransferWizardPage />;
}
