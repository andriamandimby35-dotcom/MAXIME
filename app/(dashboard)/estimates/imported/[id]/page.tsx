import { notFound } from "next/navigation";
import { getContext } from "@/lib/organization";
import { ImportedDevisDetail, type DevisLine } from "@/components/estimates/ImportedDevisDetail";

export const dynamic = "force-dynamic";

// Page d'un devis ajouté par PDF : même présentation que celle d'un devis du
// DAO (deux versions, interne et externe), lue directement dans les lignes du
// chantier. Marche aussi pour les anciens devis ajoutés par PDF.
export default async function ImportedDevisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, organizationId, memberRole } = await getContext();
  if (!organizationId) notFound();

  type ProjectRow = { id: string; name: string; created_at: string | null; expected_margin_percent?: number | string | null };
  let project: ProjectRow | null = null;
  for (const columns of ["id,name,created_at,expected_margin_percent", "id,name,created_at"]) {
    const result = await supabase.from("projects").select(columns).eq("id", id).eq("organization_id", organizationId).maybeSingle();
    if (!result.error) { project = result.data as unknown as ProjectRow; break; }
  }
  if (!project) notFound();

  let lines: DevisLine[] = [];
  for (const columns of ["id,position,designation,unit,quantity,unit_price,external_unit_price,is_internal,category,subcategory", "id,designation,unit,quantity,unit_price,external_unit_price,is_internal"]) {
    const result = await supabase.from("project_price_items").select(columns).eq("project_id", id).order("created_at", { ascending: true }).range(0, 4999);
    if (!result.error) { lines = (result.data ?? []) as unknown as DevisLine[]; break; }
  }
  const isAdmin = memberRole === "admin" || memberRole === "owner";
  return (
    <div className="p-6">
      <ImportedDevisDetail
        project={{ id: project.id, name: project.name, createdAt: project.created_at ?? null, marginPercent: project.expected_margin_percent === null || project.expected_margin_percent === undefined ? null : Number(project.expected_margin_percent) }}
        lines={lines}
        isAdmin={isAdmin}
      />
    </div>
  );
}
