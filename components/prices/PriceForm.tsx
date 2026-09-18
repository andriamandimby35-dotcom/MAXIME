"use client";

import { useState } from "react";
import { MADAGASCAR_REGIONS } from "@/lib/material-normalization";

type Caracteristique = { label: string; valeur: string };

export default function PriceForm(){

const [designation,setDesignation] = useState("");
const [categorie,setCategorie] = useState("");
const [unite,setUnite] = useState("");
const [prix,setPrix] = useState("");
const [fournisseur,setFournisseur] = useState("");
const [lieu,setLieu] = useState("");
const [region,setRegion] = useState("");
const [disponibilite,setDisponibilite] = useState("");
const [livraison,setLivraison] = useState("");
const [caracteristiques,setCaracteristiques] = useState<Caracteristique[]>([]);
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
setRegion("");
setDisponibilite("");
setLivraison("");
setCaracteristiques([]);
setSource("Prix entreprise");
setVenduParPiece(false);
setUniteAchat("");
setQuantiteParPiece("");
setPrixParPiece("");
}

function addCaracteristique(){
setCaracteristiques((current) => [...current, { label: "", valeur: "" }]);
}

function updateCaracteristique(index:number, field:"label"|"valeur", value:string){
setCaracteristiques((current) => current.map((item,i) => i === index ? { ...item, [field]: value } : item));
}

function removeCaracteristique(index:number){
setCaracteristiques((current) => current.filter((_,i) => i !== index));
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
  region,
  disponibilite,
  livraison,
  caracteristiques,
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
Nom
<input
placeholder="Ex : Fer Turkey Ø12, Ciment Holcim"
value={designation}
onChange={(e)=>setDesignation(e.target.value)}
/>
<small style={{display:"block",marginTop:"4px",color:"#6b776f",fontWeight:400}}>
Un nom court qui suffit à distinguer ce matériau des autres du même type (marque + diamètre, longueur, ou autre détail utile). L&apos;appellation commerciale complète peut être ajoutée plus bas, dans les caractéristiques.
</small>
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
Ville
<input
placeholder="Ex : Antananarivo"
value={lieu}
onChange={(e)=>setLieu(e.target.value)}
/>
</label>

<label>
Région
<select value={region} onChange={(e)=>setRegion(e.target.value)}>
<option value="">Non renseignée</option>
{MADAGASCAR_REGIONS.map((name) => <option key={name} value={name}>{name}</option>)}
</select>
</label>

</div>

<div className="formGrid mt-2">

<label>
Disponibilité
<input
placeholder="Ex : En stock, sur commande"
value={disponibilite}
onChange={(e)=>setDisponibilite(e.target.value)}
/>
</label>

<label>
Livraison
<input
placeholder="Ex : 48 h, à retirer sur place"
value={livraison}
onChange={(e)=>setLivraison(e.target.value)}
/>
</label>

</div>

<div className="mt-3">
<strong style={{fontSize:"13px"}}>Caractéristiques techniques (optionnel)</strong>
<p style={{margin:"4px 0 8px",fontSize:"12px",color:"#6b776f"}}>
Ajoute autant de caractéristiques que nécessaire (origine, norme, diamètre, longueur…) — libre à toi selon le type de matériau.
</p>
{caracteristiques.map((item, index) => (
<div key={index} style={{display:"flex",gap:"8px",marginBottom:"8px"}}>
<input
placeholder="Ex : Diamètre"
value={item.label}
onChange={(e)=>updateCaracteristique(index,"label",e.target.value)}
style={{flex:1}}
/>
<input
placeholder="Ex : 12 mm"
value={item.valeur}
onChange={(e)=>updateCaracteristique(index,"valeur",e.target.value)}
style={{flex:1}}
/>
<button type="button" className="dangerButton" onClick={()=>removeCaracteristique(index)}>×</button>
</div>
))}
<button type="button" className="ghostButton" onClick={addCaracteristique}>
+ Ajouter une caractéristique
</button>
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
