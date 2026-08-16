"use client";

import { useState } from "react";

export default function PriceForm(){

const [designation,setDesignation] = useState("");
const [categorie,setCategorie] = useState("");
const [unite,setUnite] = useState("");
const [prix,setPrix] = useState("");
const [source,setSource] = useState("Prix entreprise");

async function savePrice(){

const response = await fetch("/api/prices",{
  method:"POST",
  headers:{
    "Content-Type":"application/json"
  },
  body:JSON.stringify({
  designation,
  categorie,
  unite,
  prix:Number(prix),
  source
})
});


const result = await response.json();

console.log(result);

}


return (

<div className="w-full">
<form>

<div className="border rounded-lg p-5 mt-5">

<h2 className="font-bold text-lg">
Ajouter un prix
</h2>


<input
className="border p-2 w-full mt-3"
placeholder="Désignation"
value={designation}
onChange={(e)=>setDesignation(e.target.value)}
/>


<input
className="border p-2 w-full mt-3"
placeholder="Catégorie"
value={categorie}
onChange={(e)=>setCategorie(e.target.value)}
/>


<input
className="border p-2 w-full mt-3"
placeholder="Unité"
value={unite}
onChange={(e)=>setUnite(e.target.value)}
/>


<input
className="border p-2 w-full mt-3"
placeholder="Prix Ariary"
value={prix}
onChange={(e)=>setPrix(e.target.value)}
/>


<div className="mt-6 flex gap-3 justify-center items-center">
<button
onClick={()=>setSource("Prix entreprise")}
className="button mt-4"

>
Mon prix
</button>


<button
onClick={()=>setSource("IA")}
className="button mt-4"

>
Prix IA
</button>

<button
onClick={savePrice}
className="button mt-4"

>
Enregistrer
</button>

</div>




</div>   

</form>

</div>

);
}