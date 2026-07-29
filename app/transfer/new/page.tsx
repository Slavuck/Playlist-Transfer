import type { Metadata } from "next";
import { TransferWizardPage } from "../../components/transfer-wizard-page";

export const metadata: Metadata = { title: "Новый перенос" };

export default function NewTransferPage() {
  return <TransferWizardPage />;
}
