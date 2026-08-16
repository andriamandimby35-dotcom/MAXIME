import EstimateBuilder from "@/components/estimates/EstimateBuilder";

export default async function NewEstimatePage({
  searchParams,
}: {
  searchParams: Promise<{ tenderId?: string }>;
}) {
  const { tenderId } = await searchParams;

  return (
    <div className="p-6">
      <h1 className="mb-6 text-2xl font-bold">Nouveau devis</h1>
      <EstimateBuilder showHistory={false} sourceTenderId={tenderId ?? null} />
    </div>
  );
}
