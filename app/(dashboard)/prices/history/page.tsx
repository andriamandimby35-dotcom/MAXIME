import { getContext } from "@/lib/organization";
import { formatAr } from "@/lib/format-number";



type PriceHistory = {
  id: string;
  ancien_prix: number;
  nouveau_prix: number;
  difference: number;
  pourcentage_variation: number;
  type_variation: string;
  date_modification: string;

  price_library: {
    designation: string;
    categorie: string;
    unite: string;
  } | null;
};


export default async function PriceHistoryPage(){


const {
supabase,
organizationId
}=await getContext();



const {data:history,error}=await supabase
.from("price_history")
.select(`
id,
ancien_prix,
nouveau_prix,
difference,
pourcentage_variation,
type_variation,
date_modification,

price_library(
designation,
categorie,
unite
)

`)
.eq(
"organization_id",
organizationId
)
.order(
"date_modification",
{
ascending:false
}
)
.returns<PriceHistory[]>();



return (

<div className="p-6">


<h1 className="text-2xl font-bold">
📊 Historique des prix IA
</h1>


<p className="text-gray-500 mt-2">
Suivi des évolutions de prix matériaux et prestations
</p>



<div className="mt-6">


{
history && history.length > 0 ?


history.map((item)=>(


<div
key={item.id}
className="bg-white border-2 border-blue-500 rounded-xl p-6 mb-5 shadow-lg"
>

<div className="flex justify-between items-start">
    

<div>

<h2 className="text-lg font-bold">
{item.price_library?.designation}
</h2>

<p className="text-gray-500 mt-1">
🏷️ {item.price_library?.categorie} | 📦 {item.price_library?.unite}
</p>

</div>


<div>

{
item.type_variation === "augmentation"
?
<span className="bg-red-100 text-red-700 px-3 py-1 rounded-full font-bold">
🔴 Augmentation +{item.pourcentage_variation} %
</span>

:

item.type_variation === "diminution"
?
<span className="bg-green-100 text-green-700 px-3 py-1 rounded-full font-bold">
🟢 Diminution {item.pourcentage_variation} %
</span>

:

<span className="bg-gray-100 text-gray-700 px-3 py-1 rounded-full font-bold">
⚪ Stable
</span>

}

</div>

</div>


<div className="grid grid-cols-3 gap-4 mt-5">


<div className="bg-gray-50 border rounded-lg p-4 shadow-sm">

<p className="text-gray-500">
Ancien prix
</p>

<p className="font-bold text-lg">
{formatAr(Number(item.ancien_prix))}
</p>

</div>



<div className="bg-gray-50 border rounded-lg p-4 shadow-sm">

<p className="text-gray-500">
Nouveau prix
</p>

<p className="font-bold text-lg">
{formatAr(Number(item.nouveau_prix))}
</p>

</div>



<div className="bg-gray-50 border rounded-lg p-4 shadow-sm">

<p className="text-gray-500">
Variation
</p>

<p className="font-bold text-lg">
{formatAr(Number(item.difference))}
</p>

</div>


</div>


<p className="text-sm text-gray-500 mt-5 border-t pt-3">
📅 {new Date(item.date_modification).toLocaleDateString("fr-FR")}
</p>

</div>

))

:
<p>
  Aucun historique disponible
</p>

}

</div>

</div>

);
}