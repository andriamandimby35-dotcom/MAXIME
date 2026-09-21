"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useParams, useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { GenerateSubmissionDossierButton } from "@/components/tenders/GenerateSubmissionDossierButton";


export default function AnalyzeDAOPage() {


  const params = useParams();
  const router = useRouter();

  const id = params.id as string;


  const supabase = useMemo(() => createClient(), []);



  const [tender, setTender] = useState<any>(null);

  const [analysis, setAnalysis] = useState<string>("");

  const [loading, setLoading] = useState(false);

  const [analysisProgress, setAnalysisProgress] = useState(0);

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



  },[id, supabase]);

  useEffect(() => {
    if (!loading) return;
    const timer = window.setInterval(() => {
      setAnalysisProgress((current) => current >= 92 ? current : Math.min(92, current + Math.max(1, Math.ceil((92 - current) * 0.08))));
    }, 950);
    return () => window.clearInterval(timer);
  }, [loading]);









async function analyzeDAO(){

let analysisFinished = false;


if(!tender?.document_url){


setMessage(
"Aucun document PDF trouvé pour ce DAO"
);


return;

}



try{


setLoading(true);

setAnalysisProgress(5);


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
"✅ Analyse terminée avec succès — 100 %"
);

analysisFinished = true;
setAnalysisProgress(100);
await new Promise((resolve) => window.setTimeout(resolve, 450));




}

catch(error){


console.log(error);


setMessage(
"Erreur pendant l'analyse IA"
);


}


finally{


setLoading(false);

if (!analysisFinished) setAnalysisProgress(0);


}


}









return (

<main className="daoAnalysisPage p-10">

<button className="tenderBackLink" onClick={() => router.push("/tenders")}>← Retour aux appels d’offres</button>



<h1 className="daoAnalysisTitle text-3xl font-bold mb-8">

🤖 Analyse IA du DAO

</h1>






{

tender && (



<div>



<section className="daoAnalysisHero bg-white p-6 rounded-xl shadow">


<h2 className="
text-2xl
font-bold
mb-4
">

{tender.title}

</h2>



<div className="daoAnalysisMetaGrid">

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





</div>

<button

onClick={analyzeDAO}

disabled={loading}


className="tenderButton tenderButtonPrimary mt-6 disabled:opacity-50"


>


{

loading

?

"Analyse en cours..."

:

parsedAnalysis ? "🤖 Ré-analyser le DAO avec IA" : "🤖 Analyser le DAO avec IA"

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









<section className="daoAnalysisResult mt-8 bg-gray-100 p-6 rounded-xl">


<h2 className="
text-2xl
font-bold
mb-6
">

📊 Résultat analyse IA

</h2>

{parsedAnalysis && tender && (
<div className="buttonRow">
  <button
    onClick={() => router.push(`/estimates/new?tenderId=${tender.id}`)}
    className="tenderButton tenderButtonPrimary"
  >
    📄 Générer le devis IA
  </button>
  <GenerateSubmissionDossierButton tenderId={tender.id} />
</div>
)}

{loading && (
<aside
  role="status"
  aria-live="polite"
  className="daoAnalysisProgress"
>
  <strong>🤖 Analyse du PDF en cours</strong>
  <p style={{ marginTop: 8, fontSize: 14 }}>
    Lecture des pages, tableaux, catégories et suggestions internes. Ne fermez pas cette page.
  </p>
  <div className="appProgress daoAnalysisProgressBar" role="progressbar" aria-label="Analyse du DAO en cours" aria-valuemin={0} aria-valuemax={100} aria-valuenow={analysisProgress} aria-valuetext={`${analysisProgress} %`}>
    <span style={{ width: `${analysisProgress}%` }} />
  </div>
</aside>
)}





{

parsedAnalysis ?



<div className="space-y-5">





<div className="daoAnalysisCard daoAnalysisSummary bg-white p-5 rounded-lg">

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









<div className="daoAnalysisCard daoWorksCard bg-white p-5 rounded-lg">


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
      className="daoWorkSection"
  >
    {lot.designation}
  </div>
) : lot.row_type === "subtotal" || lot.row_type === "total" ? (
  <div
    key={index}
      className={lot.row_type === "total" ? "daoWorkTotal" : "daoWorkSubtotal"}
  >
    {lot.designation}
  </div>
) : (
  <div key={index} className="daoWorkItem border-b py-3">
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
<div className="daoAnalysisCard daoInternalSuggestions rounded-lg border-2 border-amber-400 bg-amber-50 p-5">
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

<div className="daoAnalysisCard daoFinancialCard bg-white p-5 rounded-lg">


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

Le DAO n&apos;a pas encore été analysé.

</p>



}




</section>





</div>


)


}



</main>


);


}
