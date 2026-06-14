import { ReceiptDrop } from '../components/receipts/ReceiptDrop';

export default function ReceiptsPage() {
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <h1 className="mb-8 text-2xl font-semibold">Upload a Receipt</h1>
      <ReceiptDrop />
    </main>
  );
}
