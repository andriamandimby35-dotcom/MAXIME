import Link from "next/link";
import { getContext } from "@/lib/organization";
import { formatAr } from "@/components/money";
import { RealtimeRefresh } from "@/components/realtime-refresh";

type LineData = Record<string, unknown>;

function numberFrom(line: LineData, keys: string[]) {
  for (const key of keys) {
    const raw = line[key];
    const value = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/\s/g, "").replace(",", "."));
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function lineTotal(line: LineData) {
  const stored = numberFrom(line, ["Total", "total"]);
  return stored || numberFrom(line, ["Quantité", "Quantite", "quantite"]) * numberFrom(line, ["Prix unitaire", "prix_unitaire"]);
}

function isItem(line: LineData) {
  return !["section", "subtotal"].includes(String(line.__daoRowType ?? "item"));
}

function isInternal(line: LineData) {
  return line.__internalOnly === true || line.__internalOnly === "true" || line.__disabledInternal === true;
}

function isMaterial(line: LineData) {
  const category = String(line.__daoCategory ?? line.__priceCategory ?? line.__internalCostKind ?? "").toLocaleLowerCase("fr-FR");
  return /materiau|matériau|material/.test(category);
}


export default async function DashboardPage() {

  const {
    supabase,
    organizationId,
    organization
  } = await getContext();


  const empty = { data: [] as any[] };


  const [
    tenders,
    estimates,
    estimateLinesResult,
    projects,
    expenses,
    priceLibrary
  ] =
    organizationId
      ? await Promise.all([

          supabase
          .from("tenders")
          .select(
            "id,title,reference,status,estimated_amount,created_at"
          )
          .eq(
            "organization_id",
            organizationId
          )
          .order(
            "created_at",
            {ascending:false}
          ),


          supabase
          .from("estimates")
          .select(
            "id,profit_margin_percent"
          )
          .eq(
            "organization_id",
            organizationId
          ),


          supabase
          .from("estimate_lines")
          .select(
            "estimate_id,data"
          ),


          supabase
          .from("projects")
          .select(
            "id,name,status,progress_percent,budget_amount"
          )
          .eq(
            "organization_id",
            organizationId
          ),


          supabase
          .from("project_material_orders")
          .select(
            "unit_price,quantity"
          )
          .eq(
            "organization_id",
            organizationId
          )
          .eq(
            "status",
            "paid"
          ),


          supabase
          .from("price_library")
          .select(
            "id,designation,categorie,prix_actuel,prix_retenu,prix_ia"
          )
          .eq(
            "organization_id",
            organizationId
          )
          .order(
            "updated_at",
            {ascending:false}
          )
          .limit(5)

        ])

      :

      [
        empty,
        empty,
        empty,
        empty,
        empty,
        empty
      ];



const totalDevis =
 estimates.data?.reduce(
 (sum:number,estimate:any)=>{
 const estimateLines = (estimateLinesResult.data ?? [])
   .filter((line:any)=>line.estimate_id===estimate.id)
   .map((line:any)=>(line.data ?? {}) as LineData)
   .filter(isItem);
 const externalLines = estimateLines.filter((line:LineData)=>!isInternal(line));
 const materialTotal = externalLines.filter(isMaterial).reduce((total:number,line:LineData)=>total+lineTotal(line),0);
 const markupBase = externalLines.filter((line:LineData)=>!isMaterial(line)).reduce((total:number,line:LineData)=>total+lineTotal(line),0);
 const margin = Number(estimate.profit_margin_percent) || 0;
 return sum + materialTotal + markupBase + (markupBase*margin/100);
 },
 0
 ) || 0;



const totalDepenses =
 expenses.data?.reduce(
 (a:number,b:any)=>
 a + Number(b.quantity || 0) * Number(b.unit_price || 0),
 0
 ) || 0;



return (

<div className="stack">

{organizationId && <RealtimeRefresh channelName="dashboard" tables={[
  { table: "tenders", filter: `organization_id=eq.${organizationId}` },
  { table: "estimates", filter: `organization_id=eq.${organizationId}` },
  "estimate_lines",
  { table: "projects", filter: `organization_id=eq.${organizationId}` },
  { table: "project_material_orders", filter: `organization_id=eq.${organizationId}` },
  { table: "price_library", filter: `organization_id=eq.${organizationId}` },
]} />}

<section className="hero">

<div>

<span className="eyebrow">
Pilotage entreprise
</span>


<h1>
Bonjour, activité de Sébastien BTP
</h1>


<p>
Gestion des appels d&apos;offres, DAO, devis,
chantiers et trésorerie avec assistance IA.
</p>


{
organization &&

<p>
Entreprise :
<strong>
{" "}
{organization.name}
</strong>
</p>

}


</div>



<Link href="/tenders">
Analyser un DAO avec l’IA
</Link>


</section>





<div className="stats">


<article>
<span>
DAO enregistrés
</span>

<strong>
{tenders.data?.length || 0}
</strong>

<small>
Dossiers analysés
</small>

</article>



<article>

<span>
Devis générés
</span>

<strong>
{formatAr(totalDevis)}
</strong>

<small>
Montant total
</small>

</article>



<article>

<span>
Chantiers
</span>

<strong>
{
projects.data?.length || 0
}
</strong>

<small>
Projets actifs
</small>

</article>



<article>

<span>
Dépenses
</span>

<strong>
{formatAr(totalDepenses)}
</strong>

<small>
Suivi financier
</small>

</article>


</div>





<div className="grid2">



<section className="panel">

<div className="panelHead">

<h2>
Analyse DAO IA
</h2>


<Link href="/tenders">
Ouvrir
</Link>

</div>



<p>
Importer un DAO pour obtenir :
</p>


<ul>

<li>
Résumé automatique du marché
</li>

<li>
Travaux et quantités détectés
</li>

<li>
Estimation du coût
</li>

<li>
Préparation du devis
</li>


</ul>


</section>





<section className="panel">

<div className="panelHead">

<h2>
Bibliothèque des prix
</h2>


<Link href="/prices">
Voir tout
</Link>

</div>



{
priceLibrary.data?.length ?

priceLibrary.data.map((p:any)=>(

<p key={p.id}>
{p.designation}
-
{formatAr(Number(p.prix_retenu || p.prix_actuel || p.prix_ia || 0))}
</p>

))

:

<p>
Aucun prix enregistré
</p>

}



</section>


</div>






<section className="panel">


<div className="panelHead">

<h2>
Derniers appels d’offres
</h2>


<Link href="/tenders">
Voir tout
</Link>


</div>




{
tenders.data?.length ?

tenders.data.map((t:any)=>(

<p key={t.id}>

{t.title}

</p>

))

:

<p>
Aucun DAO actuellement
</p>

}


</section>






</div>

);

}
