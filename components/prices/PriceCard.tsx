"use client";

import { useState } from "react";
import PriceActions from "./PriceActions";
import { formatAr } from "@/lib/format-number";


export default function PriceCard({price}:{price:any}){


const [open,setOpen] = useState(false);


return (

<div
onClick={()=>setOpen(!open)}
className="priceCard cursor-pointer">


<div className="space-y-2">


<div className="font-bold text-xl">
{price.designation}
</div>


<div className="source">
Source : {price.prix_source || "Entreprise"}
</div>


<div className="confidence">
Confiance IA : {price.confiance_ia || 0} %
</div>


<div>
Région : {price.region || "Madagascar"}
</div>


<div>
Statut : {price.statut_prix || "entreprise"}
</div>


<div>
Origine : {price.origine_prix || "manuel"}
</div>


<div>
Dernière modification :
{" "}
{new Date(price.updated_at).toLocaleDateString("fr-FR")}
</div>


<div>
{price.categorie} | {price.unite}
</div>


<div className="mt-3 flex items-baseline gap-2">

<span>
Prix actuel :
</span>

<span className="priceValue">
{formatAr(
  Number(
    price.prix_actuel && price.prix_actuel > 0
      ? price.prix_actuel
      : price.prix_ia
  )
)}</span>

</div>


</div>


{
open && (
  <div
    onClick={(e)=>e.stopPropagation()}
    className="flex flex-col gap-2 ml-auto justify-center"
  >
    <PriceActions price={price}/>
  </div>
)
}


</div>

)

}