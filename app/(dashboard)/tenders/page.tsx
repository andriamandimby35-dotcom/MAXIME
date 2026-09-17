import Link from "next/link";
import { getContext } from "@/lib/organization";
import DeleteTenderButton from "@/components/tenders/DeleteTenderButton";
import { RealtimeRefresh } from "@/components/realtime-refresh";

function statusLabel(status?: string | null) {
  const labels: Record<string, string> = {
    draft: "Brouillon",
    analyzed: "Analysé par l’IA",
    ready: "Prêt à déposer",
    submitted: "Déposé",
    won: "Attribué",
    lost: "Non retenu",
    archived: "Archivé",
  };
  return labels[String(status ?? "").toLowerCase()] ?? status ?? "Brouillon";
}

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



      <div className="tenderListCard overflow-hidden rounded-xl border">

        <table className="w-full">

          <thead>

            <tr>

              <th className="text-left p-4">
                RÉFÉRENCE
              </th>


              <th className="text-left p-4">
                MARCHÉ
              </th>


              <th className="text-left p-4">
                AUTORITÉ
              </th>


              <th className="text-left p-4">
                ÉCHÉANCE
              </th>


              <th className="text-left p-4">
                MONTANT
              </th>


              <th className="text-left p-4">
                STATUT
              </th>

              <th className="text-left p-4">
                ACTIONS
              </th>


            </tr>

          </thead>



          <tbody>


            {tenders?.map((tender) => {
              const hasAnalysis = Boolean(tender.ai_analysis);
              return (

              <tr key={tender.id} className="tenderSelectRow">


                <td className="p-4" data-label="Référence">


                  <Link
                    href={`/tenders/${tender.id}/analyze`}
                    className="tenderSelectLink"
                  >

                    {tender.reference}

                  </Link>


                </td>

                <td className="p-4" data-label="Marché">
                  {tender.title}
                </td>



                <td className="p-4" data-label="Autorité">
                  {tender.description}
                </td>



                <td className="p-4" data-label="Échéance">

                  {tender.deadline
                    ? new Date(
                        tender.deadline
                      ).toLocaleDateString("fr-FR")
                    : "-"
                  }

                </td>



                <td className="p-4" data-label="Montant">

                  {Number(
                    tender.estimated_amount
                  ).toLocaleString("fr-FR")}

                  {" "}Ar

                </td>



                <td className="p-4" data-label="Statut">

                  <span className="
                  text-gray-700
                  ">
                    {hasAnalysis ? "Analysé" : "À analyser"}
                  </span>

                </td>

                <td className="p-4 tenderRowActions" data-label="Actions">
                  {tender.document_url ? (
                    <a
                      href={`/pdf-viewer?document=${encodeURIComponent(`/api/tenders/${tender.id}/document`)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="tenderButton"
                    >
                      Ouvrir le DAO
                    </a>
                  ) : (
                    <button type="button" disabled className="tenderButton submissionPdfDisabled">
                      DAO indisponible
                    </button>
                  )}
                  <Link href={`/tenders/${tender.id}/analyze`} className="tenderAnalyzeLink">{hasAnalysis ? "Ré-analyser" : "Analyser"}</Link>
                  <DeleteTenderButton tenderId={tender.id} tenderName={tender.title || tender.reference} />
                </td>



              </tr>
              );
            })}



            {(!tenders || tenders.length === 0) && (

              <tr>

                <td
                  colSpan={7}
                  className="p-8 text-center text-gray-500"
                >

                  Aucun appel d&apos;offre

                </td>

              </tr>

            )}


          </tbody>


        </table>


      </div>


    </main>

  );
}
