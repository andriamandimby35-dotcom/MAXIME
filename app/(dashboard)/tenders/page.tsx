import Link from "next/link";
import { getContext } from "@/lib/organization";
import DeleteTenderButton from "@/components/tenders/DeleteTenderButton";

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

  const { supabase } = await getContext();


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
          Erreur chargement appels d'offres
        </h1>
      </main>
    );
  }


  return (

    <main className="p-8">

      <div className="flex justify-between items-center mb-8">

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
          className="
          bg-green-800
          text-white
          px-5
          py-3
          rounded-lg
          "
        >
          + Ajouter
        </Link>

      </div>



      <div className="overflow-hidden rounded-xl border">

        <table className="w-full">

          <thead className="bg-gray-50">

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


            {tenders?.map((tender) => (

              <tr
                key={tender.id}
                className="border-t hover:bg-gray-50"
              >


                <td className="p-4">


                  <Link
                    href={`/tenders/${tender.id}`}
                    className="
                    text-green-800
                    hover:underline
                    "
                  >

                    {tender.reference}

                  </Link>


                </td>

                <td className="p-4">
                  {tender.title}
                </td>



                <td className="p-4">
                  {tender.description}
                </td>



                <td className="p-4">

                  {tender.deadline
                    ? new Date(
                        tender.deadline
                      ).toLocaleDateString("fr-FR")
                    : "-"
                  }

                </td>



                <td className="p-4">

                  {Number(
                    tender.estimated_amount
                  ).toLocaleString("fr-FR")}
                  
                  {" "}Ar

                </td>



                <td className="p-4">

                  <span className="
                  text-gray-700
                  ">
                    {statusLabel(tender.status)}
                  </span>

                </td>

                <td className="p-4">
                  <DeleteTenderButton tenderId={tender.id} tenderName={tender.title || tender.reference} />
                </td>



              </tr>

            ))}



            {(!tenders || tenders.length === 0) && (

              <tr>

                <td
                  colSpan={7}
                  className="p-8 text-center text-gray-500"
                >

                  Aucun appel d'offre

                </td>

              </tr>

            )}


          </tbody>


        </table>


      </div>


    </main>

  );
}
