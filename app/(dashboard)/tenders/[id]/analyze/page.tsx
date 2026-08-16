"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useParams, useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";


export default function AnalyzeDAOPage() {


  const params = useParams();
  const router = useRouter();

  const id = params.id as string;


  const supabase = createClient();



  const [tender, setTender] = useState<any>(null);

  const [analysis, setAnalysis] = useState<string>("");

  const [loading, setLoading] = useState(false);

  const [message, setMessage] = useState("");




  /*
    Transformation du résultat IA JSON
  */

  const parsedAnalysis = useMemo(() => {

    try {

      return JSON.parse(analysis);

    }

    catch {

      return null;

    }

  }, [analysis]);

  const displayedLots = useMemo(() => {
    const lots = Array.isArray(parsedAnalysis?.lots) ? parsedAnalysis.lots : [];
    if (lots.some((lot:any) => lot.row_type === "section" || lot.row_type === "subtotal")) {
      return lots;
    }

    const structured:any[] = [];
    let currentCategory = "";
    for (const lot of lots) {
      const category = String(lot.categorie || lot.category || "AUTRES OUVRAGES").trim();
      if (category !== currentCategory) {
        if (currentCategory) {
          structured.push({
            row_type: "subtotal",
            designation: `SOUS-TOTAL ${currentCategory}`,
          });
        }
        currentCategory = category;
        structured.push({
          row_type: "section",
          designation: currentCategory,
        });
      }
      structured.push({ ...lot, row_type: "item" });
    }
    if (currentCategory) {
      structured.push({
        row_type: "subtotal",
        designation: `SOUS-TOTAL ${currentCategory}`,
      });
      structured.push({ row_type: "total", designation: "TOTAL GÉNÉRAL" });
    }
    return structured;
  }, [parsedAnalysis]);






  /*
    Chargement DAO
  */

  useEffect(() => {


    async function loadTender(){


      const {data,error}=await supabase

      .from("tenders")

      .select("*")

      .eq("id",id)

      .single();




      if(error){


        console.log(error);

        setMessage(
          "Erreur chargement DAO"
        );

        return;

      }



      setTender(data);




      if(data.ai_analysis){


        if(typeof data.ai_analysis === "string"){

          setAnalysis(
            data.ai_analysis
          );

        }

        else{


          setAnalysis(

            JSON.stringify(
              data.ai_analysis,
              null,
              2
            )

          );

        }

      }



    }



    if(id){

      loadTender();

    }



  },[id]);









async function analyzeDAO(){


if(!tender?.document_url){


setMessage(
"Aucun document PDF trouvé pour ce DAO"
);


return;

}



try{


setLoading(true);


setMessage(
"Analyse IA du DAO en cours..."
);




const response = await fetch(

"/api/analyze-dao",

{

method:"POST",

headers:{

"Content-Type":"application/json"

},


body:JSON.stringify({

tenderId:tender.id,

pdfUrl:tender.document_url

})

}

);





const result = await response.json();




console.log(result);




if(result.error){


setMessage(
result.error
);


return;

}





setAnalysis(

typeof result.analysis === "string"

?

result.analysis

:

JSON.stringify(

result.analysis,

null,

2

)

);





setMessage(
"Analyse terminée avec succès"
);




}

catch(error){


console.log(error);


setMessage(
"Erreur pendant l'analyse IA"
);


}


finally{


setLoading(false);


}


}









return (

<main className="p-10">



<h1 className="text-3xl font-bold mb-8">

🤖 Analyse IA du DAO

</h1>






{

tender && (



<div>



<section className="
bg-white
p-6
rounded-xl
shadow
">


<h2 className="
text-2xl
font-bold
mb-4
">

{tender.title}

</h2>




<p>

<strong>
Référence :
</strong>

{" "}

{tender.reference}

</p>




<p>

<strong>
Client :
</strong>

{" "}

{tender.client_name}

</p>





<p>

<strong>
Description :
</strong>

{" "}

{tender.description}

</p>





<p>

<strong>
Montant estimé :
</strong>

{" "}

{tender.estimated_amount}

Ar

</p>





<button

onClick={analyzeDAO}

disabled={loading}


className="
mt-6
bg-green-700
text-white
px-6
py-3
rounded-lg
font-bold
disabled:bg-gray-400
"


>


{

loading

?

"Analyse en cours..."

:

"🤖 Analyser le DAO avec IA"

}



</button>




<p className="
mt-4
text-blue-700
font-semibold
">

{message}

</p>



</section>









<section className="
mt-8
bg-gray-100
p-6
rounded-xl
">


<h2 className="
text-2xl
font-bold
mb-6
">

📊 Résultat analyse IA

</h2>

{parsedAnalysis && tender && (
<button
  onClick={() => router.push(`/estimates/new?tenderId=${tender.id}`)}
  style={{
    marginBottom: 20,
    padding: "12px 20px",
    border: "2px solid #1d4ed8",
    borderRadius: 8,
    background: "#1d4ed8",
    color: "white",
    fontWeight: 800,
    cursor: "pointer",
  }}
>
  📄 Générer le devis IA
</button>
)}

{loading && (
<aside
  role="status"
  aria-live="polite"
  style={{
    position: "fixed",
    right: 20,
    bottom: 20,
    zIndex: 9999,
    width: "min(420px, calc(100vw - 40px))",
    padding: 18,
    border: "2px solid #2563eb",
    borderRadius: 12,
    background: "#eff6ff",
    color: "#172554",
    boxShadow: "0 12px 30px rgba(0,0,0,0.25)",
  }}
>
  <strong>🤖 Analyse du PDF en cours</strong>
  <p style={{ marginTop: 8, fontSize: 14 }}>
    Lecture des pages, tableaux, catégories et suggestions internes. Ne fermez pas cette page.
  </p>
  <progress
    aria-label="Analyse du DAO en cours"
    style={{ width: "100%", height: 18, marginTop: 14 }}
  />
</aside>
)}





{

parsedAnalysis ?



<div className="space-y-5">





<div className="
bg-white
p-5
rounded-lg
">

<h3 className="
text-xl
font-bold
">

📄 Résumé du marché

</h3>


<p className="mt-3">

{
parsedAnalysis.resume
||
"Analyse disponible"
}

</p>


</div>









<div className="
bg-white
p-5
rounded-lg
">


<h3 className="
text-xl
font-bold
">

🏗️ Travaux détectés

</h3>




{

displayedLots.map(

(lot:any,index:number)=>(

lot.row_type === "section" ? (
  <div
    key={index}
    style={{
      marginTop: 20,
      padding: "14px 12px",
      border: "2px solid #111827",
      background: "#d1d5db",
      fontSize: 18,
      fontWeight: 900,
      textTransform: "uppercase",
    }}
  >
    {lot.designation}
  </div>
) : lot.row_type === "subtotal" || lot.row_type === "total" ? (
  <div
    key={index}
    style={{
      marginTop: lot.row_type === "total" ? 22 : 0,
      padding: lot.row_type === "total" ? "16px 12px" : "12px",
      border: lot.row_type === "total" ? "3px double #111827" : "1px solid #6b7280",
      background: lot.row_type === "total" ? "#9ca3af" : "#f3f4f6",
      fontSize: lot.row_type === "total" ? 19 : 16,
      fontWeight: 900,
      textTransform: "uppercase",
      textAlign: "right",
    }}
  >
    {lot.designation}
  </div>
) : (
  <div key={index} className="border-b py-3">
    <p><strong>Désignation :</strong> {lot.designation}</p>
    <p><strong>Quantité :</strong> {lot.quantite ?? "À confirmer"} {lot.unite}</p>
  </div>
)


)

)


}




</div>










{Array.isArray(parsedAnalysis.internal_cost_recommendations) &&
parsedAnalysis.internal_cost_recommendations.length > 0 && (
<div className="rounded-lg border-2 border-amber-400 bg-amber-50 p-5">
  <h3 className="text-xl font-bold">Suggestions internes hors DAO</h3>
  <p className="mt-2 text-sm">
    Ces éléments servent au calcul du coût réel du chantier et seront exclus du PDF de soumission.
  </p>
  {parsedAnalysis.internal_cost_recommendations.map((item:any,index:number)=>(
    <div key={index} className="border-b border-amber-300 py-3">
      <p><strong>{item.title || item.kind} :</strong> {item.designation}</p>
      <p><strong>Quantité :</strong> {item.quantity ?? "À confirmer"} {item.unit}</p>
      <p><strong>Pourquoi :</strong> {item.reason}</p>
      <p><strong>Base de proposition :</strong> {item.source_basis}</p>
      {Array.isArray(item.options) && item.options.length > 0 && (
        <p><strong>Choix possibles :</strong> {item.options.join(" / ")}</p>
      )}
      {item.default_option && <p><strong>Choix proposé :</strong> {item.default_option}</p>}
      {item.safety_note && <p className="font-semibold text-red-700">{item.safety_note}</p>}
    </div>
  ))}
</div>
)}

<div className="
bg-white
p-5
rounded-lg
">


<h3 className="
text-xl
font-bold
">

💰 Analyse financière

</h3>




<p>

Marge recommandée :

<strong>

{" "}

{parsedAnalysis.marge_globale || 30}

%

</strong>


</p>



</div>
















</div>





:


analysis ?



<div className="
bg-white
p-5
rounded-lg
prose
max-w-none
">


<ReactMarkdown>

{analysis}

</ReactMarkdown>


</div>





:


<p>

Le DAO n'a pas encore été analysé.

</p>



}




</section>





</div>


)


}



</main>


);


}
