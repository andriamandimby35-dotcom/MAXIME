import { getContext } from "@/lib/organization";
import PriceForm from "@/components/prices/PriceForm";
import PriceCard from "@/components/prices/PriceCard";
import Link from "next/link";



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

<div className="p-6">


<h1 className="text-2xl font-bold">
Bibliothèque des prix IA
</h1>


<p className="mt-2 text-gray-500">
Gestion des prix entreprise, IA et historiques
</p>


<div className="mt-4 flex gap-3">

<Link
href="/prices/new"
className="addPriceButton">
+ Ajouter un prix
</Link>


<Link
href="/prices/history"
className="historyButton"
>
📊 Historique des prix
</Link>

</div>

<div
style={{
display:"grid",
gridTemplateColumns:"360px 1fr",
gap:"40px",
alignItems:"start",
marginTop:"25px"
}}
>


<div className="col-span-1">

<PriceForm />

</div>



<div
style={{
display:"flex",
flexDirection:"column",
gap:"20px"
}}
>

{prices && prices.length > 0 ? (

prices.map((price)=>(


<PriceCard
key={price.id}
price={price}
/>


))

):(


<p>
Aucun prix enregistré
</p>


)}


</div>

</div>


</div>

);
}