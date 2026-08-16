import Link from "next/link";
import { getContext } from "@/lib/organization";
import { formatAr } from "@/components/money";


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
            "id,title,total_amount,status"
          )
          .eq(
            "organization_id",
            organizationId
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
          .from("expenses")
          .select(
            "amount"
          )
          .eq(
            "organization_id",
            organizationId
          ),


          supabase
          .from("price_library")
          .select(
            "id,designation,category,prix_actuel"
          )
          .limit(5)

        ])

      :

      [
        empty,
        empty,
        empty,
        empty,
        empty
      ];



const totalDevis =
 estimates.data?.reduce(
 (a:number,b:any)=>
 a + Number(b.total_amount || 0),
 0
 ) || 0;



const totalDepenses =
 expenses.data?.reduce(
 (a:number,b:any)=>
 a + Number(b.amount || 0),
 0
 ) || 0;



return (

<div className="stack">


<section className="hero">

<div>

<span className="eyebrow">
Pilotage entreprise
</span>


<h1>
Bonjour, activité de Sébastien BTP
</h1>


<p>
Gestion des appels d'offres, DAO, devis,
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
{formatAr(p.prix_actuel)}
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