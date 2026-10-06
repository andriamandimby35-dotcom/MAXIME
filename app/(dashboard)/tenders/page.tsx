import Link from "next/link";
import { getContext } from "@/lib/organization";
import { TenderCard } from "@/components/tenders/TenderCard";
import { RealtimeRefresh } from "@/components/realtime-refresh";

export default async function TendersPage() {

  const { supabase, organizationId } = await getContext();


  const { data: tenders, error } = await supabase
    .from("tenders")
    .select("*")
    .order("created_at", {
      ascending: false,
    });


  if (error) {
    console.error("ERREUR CHARGEMENT DAO :", error);

    return (
      <main className="p-8">
        <h1 className="text-2xl font-bold">
          Erreur chargement appels d&apos;offres
        </h1>
      </main>
    );
  }


  return (

    <main className="tenderListPage p-8">

      {organizationId && <RealtimeRefresh channelName="tenders-list" tables={["tenders"]} filter={`organization_id=eq.${organizationId}`} />}

      <div className="tenderListHead flex justify-between items-center mb-8">

        <div>
          <h1 className="text-4xl font-bold">
            Appels d’offres
          </h1>

          <p className="text-gray-500 mt-2">
            Suivi des marchés et dates limites de dépôt.
          </p>
        </div>


        <Link
          href="/tenders/new"
          className="tenderButton tenderButtonPrimary tenderAddButton"
        >
          + Ajouter un appel d’offres
        </Link>

      </div>



      {!tenders || tenders.length === 0 ? (
        <section className="projectEmptyCard"><h2>Aucun appel d&apos;offres</h2><p>Cliquez sur « + Ajouter un appel d’offres » pour en créer un.</p></section>
      ) : (
        <section className="projectDirectoryGrid" aria-label="Liste des appels d'offres">
          {tenders.map((tender) => (
            <TenderCard
              key={tender.id}
              tender={{
                id: tender.id,
                reference: tender.reference ?? null,
                title: tender.title ?? null,
                authority: tender.description ?? null,
                deadline: tender.deadline ?? null,
                amount: tender.estimated_amount === null || tender.estimated_amount === undefined ? null : Number(tender.estimated_amount),
                hasAnalysis: Boolean(tender.ai_analysis),
                hasDocument: Boolean(tender.document_url),
              }}
            />
          ))}
        </section>
      )}

    </main>

  );
}
