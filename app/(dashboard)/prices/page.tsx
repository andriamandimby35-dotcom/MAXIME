import { getContext } from "@/lib/organization";
import PriceForm from "@/components/prices/PriceForm";
import PriceSearch from "@/components/prices/PriceSearch";
import { RealtimeRefresh } from "@/components/realtime-refresh";



export default async function PricesPage(){

  const {
    supabase,
    organizationId
  } = await getContext();


// Supabase ne renvoie jamais plus de 1000 lignes en une seule fois (limite
// par défaut de l'API), même sans ".limit(...)" dans la requête — avec
// plusieurs milliers de matériaux, la bibliothèque était donc silencieusement
// coupée à 1000 (d'où le compteur bloqué). On récupère ici toutes les pages
// de 1000 les unes après les autres jusqu'à ce qu'il n'y ait plus rien à lire.
const PRICES_PAGE_SIZE = 1000;
let prices: Record<string, unknown>[] = [];
let pricesError: { message: string } | null = null;
for (let from = 0; ; from += PRICES_PAGE_SIZE) {
  const { data: page, error: pageError } = await supabase
    .from("price_library")
    .select("*")
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false })
    .range(from, from + PRICES_PAGE_SIZE - 1);
  if (pageError) { pricesError = pageError; break; }
  prices = prices.concat(page ?? []);
  if (!page || page.length < PRICES_PAGE_SIZE) break;
}
const error = pricesError;


console.log(
  "PRICES TEST",
  prices.length,
  error
);


  return (

<div>

<RealtimeRefresh channelName="prices-library" tables={["price_library"]} filter={`organization_id=eq.${organizationId}`} />

<div className="pageHead">
<div>
<h1>Bibliothèque de prix</h1>
<p>Tous vos prix, fournisseurs et régions au même endroit.</p>
<p style={{marginTop:"4px",fontWeight:600}}>
{(prices ?? []).length} matériau{(prices ?? []).length > 1 ? "x" : ""} enregistré{(prices ?? []).length > 1 ? "s" : ""}
</p>
</div>
</div>

<div style={{marginTop:"20px"}}>

<div style={{maxWidth:"640px"}}>

<PriceForm />

</div>

<div style={{marginTop:"30px"}}>

<PriceSearch prices={prices ?? []} />

</div>

</div>


</div>

);
}
