import Link from "next/link";
import { getContext } from "@/lib/organization";
import { AnalyzerForm } from "./analyzer-form";

export default async function AnalyzeTenderPage() {
  const { supabase, organizationId } = await getContext();
  const { data: tenders } = organizationId
    ? await supabase
      .from("tenders")
      .select("id,reference,title")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
    : { data: [] };

  return (
    <section>
      <div className="pageHead">
        <div>
          <Link className="tenderBackLink" href="/tenders">← Retour aux appels d’offres</Link>
          <h1>Analyse IA d’un DAO</h1>
          <p>Transformez un dossier volumineux en checklist opérationnelle.</p>
        </div>
      </div>
      {!tenders?.length ? (
        <div className="panel"><p>Créez d’abord un appel d’offres avant de lancer une analyse.</p></div>
      ) : (
        <AnalyzerForm tenders={tenders} />
      )}
    </section>
  );
}
