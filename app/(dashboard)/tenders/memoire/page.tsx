import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { MemoireGenerator } from "./memoire-generator";

export default async function MemoirePage() {
  const supabase = await createClient();
  const { data: tenders } = await supabase
    .from("tenders")
    .select("id,reference,title,status,summary,requirements,missing_documents")
    .not("summary", "is", null)
    .order("updated_at", { ascending: false });

  return (
    <section>
      <div className="pageHead">
        <div>
          <Link className="backLink" href="/tenders">← Retour aux appels d’offres</Link>
          <h1>Mémoire technique et checklist</h1>
          <p>Générez une première trame professionnelle à partir d’un DAO déjà analysé.</p>
        </div>
      </div>
      {!tenders?.length ? (
        <div className="panel">
          <p>Analysez d’abord un DAO. Le mémoire technique s’appuie sur les exigences réellement extraites du dossier.</p>
          <Link className="secondaryButton" href="/tenders/analyze">Analyser un DAO</Link>
        </div>
      ) : (
        <MemoireGenerator tenders={tenders} />
      )}
    </section>
  );
}
