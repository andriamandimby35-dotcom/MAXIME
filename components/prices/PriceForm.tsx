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
const [checkingDuplicate,setCheckingDuplicate] = useState(false);
// Matériau déjà existant (même nom, une fois les majuscules/accents/ponctuation
// ignorés) détecté avant l'enregistrement, pour demander confirmation à
// l'utilisateur (voir savePrice ci-dessous).
const [duplicateMatch,setDuplicateMatch] = useState<any>(null);
// Id du matériau existant que l'utilisateur a confirmé être le même : permet
// à l'enregistrement de continuer sans redemander confirmation.
const [confirmedSameAsId,setConfirmedSameAsId] = useState<string | null>(null);

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
setDuplicateMatch(null);
setConfirmedSameAsId(null);
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

// Si un matériau du même nom a déjà été détecté mais que l'utilisateur n'a
// pas encore confirmé qu'il s'agit bien du même, on vérifie (ou on
// re-vérifie) avant d'enregistrer quoi que ce soit.
const alreadyConfirmed = duplicateMatch && confirmedSameAsId === duplicateMatch.id;

if(!alreadyConfirmed){
setCheckingDuplicate(true);
setMessage("Vérification des doublons…");

try {
const checkResponse = await fetch("/api/prices/check-duplicate",{
  method:"POST",
  headers:{ "Content-Type":"application/json" },
  body:JSON.stringify({ designation }),
});
const checkResult = await checkResponse.json();

if(checkResponse.ok && checkResult.existing){
setDuplicateMatch(checkResult.existing);
setMessage("");
return;
}
} catch {
// Si la vérification échoue (ex : pas de réseau), on laisse
// l'enregistrement continuer normalement : la base a de toute façon sa
// propre protection anti-doublon.
} finally {
setCheckingDuplicate(false);
}
}

await performSave(alreadyConfirmed ? duplicateMatch.id : undefined);

}

async function performSave(existingId?: string){

setSaving(true);
setMessage("Enregistrement…");

try {
const response = await fetch("/api/prices",{
  method:"POST",
  headers:{
    "Content-Type":"application/json"
  },
  body:JSON.stringify({
  ...(existingId ? { id: existingId } : {}),
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
setMessage(existingId ? "Prix du matériau existant mis à jour." : "Prix enregistré.");
} catch (error) {
setMessage(error instanceof Error ? error.message : "Le prix n’a pas pu être enregistré.");
} finally {
setSaving(false);
}

}

// L'utilisateur confirme que le matériau détecté est bien le même : on
// enregistre directement (ça mettra à jour son prix plutôt que d'en créer un
// deuxième).
function confirmSameMaterial(){
if(!duplicateMatch) return;
setConfirmedSameAsId(duplicateMatch.id);
void performSave(duplicateMatch.id);
}

// L'utilisateur indique que c'est un matériau différent : comme deux
// matériaux ne peuvent pas porter le même nom (protection anti-doublon), on
// ne peut pas l'enregistrer tel quel — il faut changer le nom pour le
// distinguer. Le fournisseur a son propre champ plus bas (jamais dans le
// nom) : pour distinguer deux matériaux au même nom, on ajoute plutôt la
// dimension si elle manque, ou l'origine (via une caractéristique technique
// "origine" ci-dessous, qui vient compléter automatiquement le nom).
function rejectSameMaterial(){
setDuplicateMatch(null);
setConfirmedSameAsId(null);
setMessage("Ce nom est déjà utilisé par un autre matériau. Modifie le nom pour bien le distinguer (ex : précise la dimension), ou ajoute une caractéristique « origine » si c'est ça qui les différencie — jamais le fournisseur, qui a son propre champ. Puis réessaie.");
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
onChange={(e)=>{
setDesignation(e.target.value);
// Le nom a changé : on oublie la vérification précédente, il en faudra
// une nouvelle avant de pouvoir enregistrer.
setDuplicateMatch(null);
setConfirmedSameAsId(null);
}}
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

{duplicateMatch && (
<div className="notice mt-3" style={{padding:"14px",border:"1px solid #f0ad4e"}}>
<strong>Un matériau du même nom existe déjà :</strong>
<div style={{marginTop:"8px",fontSize:"14px",lineHeight:1.6}}>
<div><strong>{duplicateMatch.designation}</strong></div>
{(Array.isArray(duplicateMatch.fournisseurs) && duplicateMatch.fournisseurs.length > 0
  ? duplicateMatch.fournisseurs
  : [{
      fournisseur: duplicateMatch.fournisseur,
      ville: duplicateMatch.ville,
      region: duplicateMatch.region,
      prix: duplicateMatch.prix_actuel,
      disponibilite: duplicateMatch.disponibilite,
      livraison: duplicateMatch.livraison,
      date_prix: duplicateMatch.date_prix,
    }]
).map((offer:any, index:number) => (
<div key={index} style={{marginTop: index > 0 ? "8px" : 0, paddingTop: index > 0 ? "8px" : 0, borderTop: index > 0 ? "1px solid #f3e2c2" : "none"}}>
{offer.fournisseur && <div>Fournisseur : <strong>{offer.fournisseur}</strong></div>}
{offer.prix != null && <div>Prix actuel : <strong>{offer.prix} Ar</strong>{duplicateMatch.unite ? ` / ${duplicateMatch.unite}` : ""}</div>}
{(offer.ville || offer.region) && <div>Lieu : {[offer.ville, offer.region].filter(Boolean).join(", ")}</div>}
{offer.disponibilite && <div>Disponibilité : {offer.disponibilite}</div>}
{offer.livraison && <div>Livraison : {offer.livraison}</div>}
{offer.date_prix && <div>Date du prix : {new Date(offer.date_prix).toLocaleDateString("fr-FR")}</div>}
</div>
))}
{Array.isArray(duplicateMatch.caracteristiques) && duplicateMatch.caracteristiques.length > 0 && (
<div style={{marginTop:"6px"}}>
Caractéristiques :
<ul style={{margin:"4px 0 0 18px"}}>
{duplicateMatch.caracteristiques.map((item:any, index:number) => (
<li key={index}>{item.label} : {item.valeur}</li>
))}
</ul>
</div>
)}
</div>
<p style={{marginTop:"10px",fontSize:"13px"}}>Est-ce le même matériau que celui que tu es en train d’ajouter ? Si oui, ton prix sera ajouté comme une offre supplémentaire (ou mis à jour si c’est le même fournisseur/lieu) — pas question de doublon.</p>
<div style={{display:"flex",gap:"10px",marginTop:"8px",flexWrap:"wrap"}}>
<button type="button" className="button" onClick={confirmSameMaterial} disabled={saving}>
Oui, c’est le même → ajouter cette offre
</button>
<button type="button" className="ghostButton" onClick={rejectSameMaterial} disabled={saving}>
Non, c’est différent
</button>
</div>
</div>
)}

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
disabled={saving || checkingDuplicate}
onClick={savePrice}
className="button mt-3"
style={{width:"100%"}}
>
{checkingDuplicate ? "Vérification…" : saving ? "Enregistrement…" : "Enregistrer"}
</button>

</div>

);
}
