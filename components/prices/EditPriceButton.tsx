"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { MADAGASCAR_REGIONS } from "@/lib/material-normalization";

type Caracteristique = { label: string; valeur: string };

export default function EditPriceButton({
  price
}:{
  price:any
}){


const [open,setOpen]=useState(false);

const [designation,setDesignation]=useState(
price.designation
);

const [prix,setPrix]=useState(
price.prix_actuel
);

const [venduParPiece,setVenduParPiece]=useState(Boolean(price.unite_achat));
const [uniteAchat,setUniteAchat]=useState(price.unite_achat || "");
const [quantiteParPiece,setQuantiteParPiece]=useState(price.quantite_par_unite_achat ?? "");
const [prixParPiece,setPrixParPiece]=useState(price.prix_unite_achat ?? "");
const [fournisseur,setFournisseur]=useState(price.fournisseur || "");
const [ville,setVille]=useState(price.ville || "");
const [region,setRegion]=useState(price.region || "");
const [disponibilite,setDisponibilite]=useState(price.disponibilite || "");
const [livraison,setLivraison]=useState(price.livraison || "");
const [caracteristiques,setCaracteristiques]=useState<Caracteristique[]>(
Array.isArray(price.caracteristiques) ? price.caracteristiques : []
);

function addCaracteristique(){
setCaracteristiques((current) => [...current, { label: "", valeur: "" }]);
}

function updateCaracteristique(index:number, field:"label"|"valeur", value:string){
setCaracteristiques((current) => current.map((item,i) => i === index ? { ...item, [field]: value } : item));
}

function removeCaracteristique(index:number){
setCaracteristiques((current) => current.filter((_,i) => i !== index));
}

async function updatePrice(){


await fetch("/api/prices/update",{

method:"POST",

headers:{
"Content-Type":"application/json"
},

body:JSON.stringify({

id:price.id,

designation,

prix:Number(prix),

unite_achat: venduParPiece ? (uniteAchat || "pièce") : null,

quantite_par_unite_achat: venduParPiece ? Number(quantiteParPiece) : null,

prix_unite_achat: venduParPiece ? Number(prixParPiece) : null,

fournisseur,

ville,

region,

disponibilite,

livraison,

caracteristiques,

})

});


window.location.reload();

}

return (

<>

<button
onClick={(e)=>{e.stopPropagation();setOpen(true);}}
className="button"
>
Modifier
</button>



{open && typeof document !== "undefined" && createPortal(

<div className="modalBackdrop" onClick={(e)=>{e.stopPropagation();setOpen(false);}}>


<div className="modal" onClick={(e)=>e.stopPropagation()} style={{width:"min(420px,100%)"}}>


<h2 className="font-bold text-xl mb-4">
Modifier le prix
</h2>



<input
className="w-full border p-3 rounded-lg mb-2"
value={designation}
onChange={(e)=>setDesignation(e.target.value)}
/>


<input
className="w-full border p-3 rounded-lg mb-2"
value={prix}
onChange={(e)=>setPrix(e.target.value)}
/>

<label style={{display:"flex",alignItems:"center",gap:"8px",fontWeight:600,marginBottom:"8px"}}>
<input type="checkbox" checked={venduParPiece} onChange={(e)=>setVenduParPiece(e.target.checked)} style={{width:"auto"}} />
Vendu par pièce/barre/plaque entière
</label>

{venduParPiece && <>
<input
className="w-full border p-3 rounded-lg mb-2"
placeholder="Nom de l’unité d’achat (ex : barre de 4 m, feuille de 6 m²)"
value={uniteAchat}
onChange={(e)=>setUniteAchat(e.target.value)}
/>
<input
className="w-full border p-3 rounded-lg mb-2"
type="number"
placeholder={`Quantité par pièce (en ${price.unite || "unité DAO"})`}
value={quantiteParPiece}
onChange={(e)=>setQuantiteParPiece(e.target.value)}
/>
<input
className="w-full border p-3 rounded-lg mb-2"
type="number"
placeholder="Prix par pièce (Ar)"
value={prixParPiece}
onChange={(e)=>setPrixParPiece(e.target.value)}
/>
</>}

<input
className="w-full border p-3 rounded-lg mb-2"
placeholder="Fournisseur"
value={fournisseur}
onChange={(e)=>setFournisseur(e.target.value)}
/>

<input
className="w-full border p-3 rounded-lg mb-2"
placeholder="Ville"
value={ville}
onChange={(e)=>setVille(e.target.value)}
/>

<select
className="w-full border p-3 rounded-lg mb-2"
value={region}
onChange={(e)=>setRegion(e.target.value)}
>
<option value="">Région non renseignée</option>
{MADAGASCAR_REGIONS.map((name) => <option key={name} value={name}>{name}</option>)}
</select>

<input
className="w-full border p-3 rounded-lg mb-2"
placeholder="Disponibilité (ex : En stock, sur commande)"
value={disponibilite}
onChange={(e)=>setDisponibilite(e.target.value)}
/>

<input
className="w-full border p-3 rounded-lg mb-2"
placeholder="Livraison (ex : 48 h, à retirer sur place)"
value={livraison}
onChange={(e)=>setLivraison(e.target.value)}
/>

<div className="mt-2 mb-2">
<strong style={{fontSize:"13px"}}>Caractéristiques techniques (optionnel)</strong>
{caracteristiques.map((item, index) => (
<div key={index} style={{display:"flex",gap:"8px",marginTop:"8px"}}>
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
<button type="button" className="ghostButton mt-2" onClick={addCaracteristique}>
+ Ajouter une caractéristique
</button>
</div>

<div style={{display:"flex",gap:"10px",marginTop:"10px"}}>

<button
onClick={updatePrice}
className="button"
>
Enregistrer
</button>



<button
onClick={()=>setOpen(false)}
className="ghostButton"
>
Annuler
</button>

</div>


</div>


</div>,

document.body,

)}


</>

);

}