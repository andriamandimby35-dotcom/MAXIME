"use client";

import { useState } from "react";
import { createPortal } from "react-dom";


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