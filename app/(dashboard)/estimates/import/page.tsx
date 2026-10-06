import { ImportDevisClient } from "@/components/estimates/ImportDevisClient";

export default async function ImportDevisPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind } = await searchParams;
  return <ImportDevisClient kind={kind === "internal" ? "internal" : "external"} />;
}
