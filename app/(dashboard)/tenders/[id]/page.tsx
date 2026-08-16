import Link from "next/link";
import { notFound } from "next/navigation";
import { getContext } from "@/lib/organization";


export default async function TenderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {

  const { id } = await params;

  const { supabase } = await getContext();


  const { data: tender, error } = await supabase
    .from("tenders")
    .select("*")
    .eq("id", id)
    .single();


  if (error || !tender) {
    console.log("ERROR :", error);
    return notFound();
  }


  return (

    <main className="p-8">

      <h1 className="text-4xl font-bold mb-8">
        {tender.title}
      </h1>


      <section className="mb-8">

        <h2 className="text-2xl font-bold mb-5">
          Informations générales
        </h2>


        <div className="space-y-3">


          <p>
            <strong>Référence :</strong>{" "}
            {tender.reference}
          </p>


          <p>
            <strong>Client :</strong>{" "}
            {tender.client_name}
          </p>


          <p>
            <strong>Description :</strong>{" "}
            {tender.description}
          </p>


          <p>
            <strong>Date limite :</strong>{" "}
            {tender.deadline}
          </p>


          <p>
            <strong>Montant estimé :</strong>{" "}
            {tender.estimated_amount} Ar
          </p>


          <p>
            <strong>Statut :</strong>{" "}
            {statusLabel(tender.status)}
          </p>


        </div>

      </section>



      <section className="mb-8">


        <h2 className="text-2xl font-bold mb-5">
          Document DAO
        </h2>


        {
          tender.document_url && (

            <a
              href={tender.document_url}
              target="_blank"
              className="text-blue-600 underline"
            >
              📄 Ouvrir le DAO PDF
            </a>

          )
        }


      </section>




      <section className="mt-10">


        <Link

          href={`/tenders/${tender.id}/analyze`}

          className="
          inline-flex
          items-center
          bg-green-700
          text-white
          px-6
          py-3
          rounded-lg
          font-bold
          hover:bg-green-800
          "

        >

          🤖 Analyser le DAO

        </Link>


      </section>



    </main>

  );
}
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
