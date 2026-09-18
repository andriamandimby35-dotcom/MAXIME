import { getContext } from "@/lib/organization";
import PriceForm from "@/components/prices/PriceForm";
import PriceSearch from "@/components/prices/PriceSearch";
import { RealtimeRefresh } from "@/components/realtime-refresh";



export default async function PricesPage(){

  const {
    supabase,
    organizationId
  } = await getContext();


  const {data:prices,error}=await supabase
.from("price_library")
.select("*")
.eq(
  "organization_id",
  organizationId
)
.order(
  "updated_at",
  {
    ascending:false
  }
);


console.log(
  "PRICES TEST",
  prices,
  error
);


  return (

<div>

<RealtimeRefresh channelName="prices-library" tables={["price_library"]} filter={`organization_id=eq.${organizationId}`} />

<div className="pageHead">
<div>
<h1>Bibliothèque de prix</h1>
<p>Tous vos prix, fournisseurs et régions au même endroit.</p>
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
