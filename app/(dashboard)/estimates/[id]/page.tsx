import EstimateBuilder from "@/components/estimates/EstimateBuilder";

export default async function EstimateEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <div className="p-6">
      <h1 className="mb-6 text-2xl font-bold">Modifier le devis</h1>
      <EstimateBuilder initialEstimateId={id} showHistory={false} />
    </div>
  );
}
