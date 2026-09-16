"use client";

import { useState } from "react";

export default function PriceForm(){

const [designation,setDesignation] = useState("");
const [categorie,setCategorie] = useState("");
const [unite,setUnite] = useState("");
const [prix,setPrix] = useState("");
const [fournisseur,setFournisseur] = useState("");
const [lieu,setLieu] = useState("");
const [source,setSource] = useState("Prix entreprise");
const [searching,setSearching] = useState(false);
const [message,setMessage] = useState("");
const [venduParPiece,setVenduParPiece] = useState(false);
const [uniteAchat,setUniteAchat] = useState("");
const [quantiteParPiece,setQuantiteParPiece] = useState("");
const [prixParPiece,setPrixParPiece] = useState("");
const [saving,setSaving] = useState(false);

function resetForm(){
setDesignation("");
setCategorie("");
setUnite("");
setPrix("");
setFournisseur("");
setLieu("");
setSource("Prix entreprise");
setVenduParPiece(false);
setUniteAchat("");
setQuantiteParPiece("");
setPrixParPiece("");
}

async function savePrice(){

if(!designation.trim() || !unite.trim() || !prix.trim()){
setMessage("Désignation, unité et prix sont obligatoires.");
return;
}

setSaving(true);
setMessage("Enregistrement…");

try {
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
  fournisseur,
  lieu,
  source,
  ...(venduParPiece ? {
    unite_achat: uniteAchat || "pièce",
    quantite_par_unite_achat: Number(quantiteParPiece),
    prix_unite_achat: Number(prixParPiece),
  } : {}),
})
});

const result = await response.json();

if(!response.ok || result.error){
setMessage(result.error || "Le prix n’a pas pu être enregistré.");
return;
}

resetForm();
setMessage("Prix enregistré.");
} catch (error) {
setMessage(error instanceof Error ? error.message : "Le prix n’a pas pu être enregistré.");
} finally {
setSaving(false);
}

}

async function searchAiPrice(){

setSource("IA");

if(!designation.trim() || !unite.trim() || !lieu.trim()){
setMessage("Désignation, unité et localisation sont nécessaires pour lancer une recherche IA.");
return;
}

setSearching(true);
setMessage("Recherche du prix en cours…");

const response = await fetch("/api/prices/internet-search",{
  method:"POST",
  headers:{
    "Content-Type":"application/json"
  },
  body:JSON.stringify({
  designation,
  categorie: categorie || undefined,
  unite,
  worksiteLocation: lieu,
  worksiteName: "Bibliothèque de prix",
})
});

const result = await response.json();

setSearching(false);

if(!response.ok){
setMessage(result.error || "Recherche IA impossible.");
return;
}

if(result.found){
setMessage(`Prix trouvé : ${result.selected_price} Ar — ${result.supplier || "fournisseur inconnu"}.`);
window.location.reload();
return;
}

setMessage(result.message || "Aucun prix vérifiable trouvé pour ce matériau.");

}


return (

<div className="panel">

<h2 className="font-bold text-lg">
Ajouter un prix
</h2>


<div className="formGrid">

<label>
Désignation
<input
placeholder="Ex : Ciment CEM II 42.5"
value={designation}
onChange={(e)=>setDesignation(e.target.value)}
/>
</label>

<label>
Catégorie
<input
placeholder="Ex : Matériaux BTP"
value={categorie}
onChange={(e)=>setCategorie(e.target.value)}
/>
</label>

<label>
Unité
<input
placeholder="Ex : sac, m3, kg"
value={unite}
onChange={(e)=>setUnite(e.target.value)}
/>
</label>

<label>
Prix Ariary
<input
placeholder="Ex : 35000"
value={prix}
onChange={(e)=>setPrix(e.target.value)}
/>
</label>

</div>

<label className="mt-3" style={{display:"flex",alignItems:"center",gap:"8px",fontWeight:600}}>
<input type="checkbox" checked={venduParPiece} onChange={(e)=>setVenduParPiece(e.target.checked)} style={{width:"auto"}} />
Vendu par pièce/barre/plaque entière, pas au {unite || "…"} (ex : bois carré en barres de 4 m, ou tôle en feuilles de 6 m²)
</label>

{venduParPiece && <div className="formGrid mt-2">
<label>
Nom de l’unité d’achat
<input
placeholder="Ex : barre de 4 m, feuille de 6 m²"
value={uniteAchat}
onChange={(e)=>setUniteAchat(e.target.value)}
/>
</label>

<label>
Quantité par pièce (en {unite || "…"})
<input
type="number"
placeholder={unite === "m2" ? "Ex : 2.98 (surface d’une plaque)" : "Ex : 4"}
value={quantiteParPiece}
onChange={(e)=>setQuantiteParPiece(e.target.value)}
/>
</label>

<label>
Prix par pièce (Ar)
<input
type="number"
placeholder="Ex : 7000"
value={prixParPiece}
onChange={(e)=>setPrixParPiece(e.target.value)}
/>
</label>
</div>}

<div className="formGrid mt-2">

<label>
Fournisseur
<input
placeholder="Ex : Ballou, ABC Bricorama"
value={fournisseur}
onChange={(e)=>setFournisseur(e.target.value)}
/>
</label>

<label>
Localisation
<input
placeholder="Ex : Antananarivo"
value={lieu}
onChange={(e)=>setLieu(e.target.value)}
/>
</label>

</div>

{message && <p className="notice mt-3" style={{padding:"10px 14px"}}>{message}</p>}

<div className="mt-4" style={{display:"flex",gap:"10px",justifyContent:"center"}}>

<button
type="button"
onClick={()=>setSource("Prix entreprise")}
className={source === "Prix entreprise" ? "button" : "ghostButton"}
>
Mon prix
</button>


<button
type="button"
disabled={searching}
onClick={searchAiPrice}
className={source === "IA" ? "button" : "ghostButton"}
>
{searching ? "Recherche…" : "Prix IA"}
</button>

</div>

<button
type="button"
disabled={saving}
onClick={savePrice}
className="button mt-3"
style={{width:"100%"}}
>
{saving ? "Enregistrement…" : "Enregistrer"}
</button>

</div>

);
}
