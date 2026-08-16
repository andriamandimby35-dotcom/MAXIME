import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { AnalyzerForm } from "./analyzer-form";

export default async function AnalyzeTenderPage() {
  const supabase = await createClient();
  const { data: tenders } = await supabase
    .from("tenders")
    .select("id,reference,title")
    .order("created_at", { ascending: false });

  return (
    <section>
      <div className="pageHead">
        <div>
          <Link className="backLink" href="/tenders">← Retour aux appels d’offres</Link>
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
