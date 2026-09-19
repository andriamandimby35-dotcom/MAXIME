"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import EditPriceButton from "./EditPriceButton";
import DeletePriceButton from "./DeletePriceButton";
import { formatAr } from "@/lib/format-number";

type PriceHistoryEntry = {
  id: string;
  ancien_prix: number;
  nouveau_prix: number;
  difference: number;
  pourcentage_variation: number;
  type_variation: string;
  date_modification: string;
  supplier_name: string | null;
};

type Caracteristique = { label: string; valeur: string };

type Offer = {
  fournisseur?: string;
  ville?: string;
  region?: string;
  prix?: number | string;
  disponibilite?: string;
  livraison?: string;
  date_prix?: string;
};

function offerLocation(offer: Offer) {
  return [offer.ville, offer.region].filter(Boolean).join(" — ");
}

function formatOfferDate(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString("fr-FR");
}

export default function PriceCard({price}:{price:any}){

const [open,setOpen] = useState(false);
const [history,setHistory] = useState<PriceHistoryEntry[] | null>(null);
const [historyError,setHistoryError] = useState("");

const currentPrice = Number(price.prix_retenu || price.prix_actuel || price.prix_ia || 0);
const isIa = price.statut_prix === "ia";
const confidencePercent = Math.round(Number(price.confiance_ia || 0) * 100);
const caracteristiques: Caracteristique[] = Array.isArray(price.caracteristiques) ? price.caracteristiques : [];

// Un même matériau peut avoir plusieurs fournisseurs/régions (voir la
// colonne "fournisseurs" de price_library) : on affiche cette liste plutôt
// que de créer une fiche par fournisseur. Si elle n'existe pas encore (prix
// pas encore migré), on reconstruit une liste d'une seule offre à partir des
// anciens champs, pour que l'affichage reste correct dans tous les cas.
const offers: Offer[] = Array.isArray(price.fournisseurs) && price.fournisseurs.length > 0
  ? price.fournisseurs
  : [{
      fournisseur: price.fournisseur || "",
      ville: price.ville || "",
      region: price.region || "",
      prix: currentPrice,
      disponibilite: price.disponibilite || "",
      livraison: price.livraison || "",
      date_prix: price.date_prix || price.updated_at,
    }];

const sortedOffers = [...offers].sort((a, b) => Number(a.prix || 0) - Number(b.prix || 0));
const cheapestOffer = sortedOffers[0];

// On ne récupère l'historique que pour retrouver le dernier changement de
// prix (ancien prix / % de variation) affiché tout en haut du détail — la
// liste complète de l'historique n'est plus affichée, pour ne pas encombrer.
useEffect(() => {
  if (!open || history !== null || historyError) return;
  fetch(`/api/prices/history?priceId=${price.id}`)
    .then((response) => response.json())
    .then((result) => {
      if (result.error) { setHistoryError(String(result.error)); return; }
      setHistory(result.data ?? []);
    })
    .catch((error) => setHistoryError(String(error)));
}, [open, history, historyError, price.id]);

const lastChange = history && history.length > 0 ? history[0] : null;

return (

<>

<div className="priceTile" onClick={()=>setOpen(true)}>

<span className={isIa ? "pill pillIa" : "pill"}>
{isIa ? "Prix IA" : "Prix entreprise"}
</span>

<div className="priceTileTitle">
{price.designation}
</div>

<div className="priceTileValue">
{formatAr(currentPrice)}
</div>

<div className="priceTileMeta">
{price.ville || price.region || "Localisation non renseignée"}
</div>

<div
onClick={(e)=>e.stopPropagation()}
className="priceTileActions"
>
<EditPriceButton price={price}/>
<DeletePriceButton id={price.id}/>
</div>

</div>

{open && typeof document !== "undefined" && createPortal(

<div className="modalBackdrop" onClick={()=>setOpen(false)}>

<div className="modal" onClick={(e)=>e.stopPropagation()}>

<h2 className="font-bold text-xl">
{price.designation}
</h2>

<p className="mt-1 text-gray-500">
{price.categorie} · {price.unite}
</p>

<div className="bottomBlock" style={{marginTop:"14px"}}>

<div className="sourceRow">
<span className="src">Source : {isIa ? "Prix IA" : "Prix entreprise"}</span>
<span className="conf">Confiance IA : {confidencePercent} %</span>
</div>

<div className="priceOffersBox" style={{background:"#f6f8f6",border:"1px solid #e4e7e5",borderRadius:"10px",padding:"14px 16px",marginTop:"12px"}}>

<div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",gap:"10px",flexWrap:"wrap"}}>
<span style={{fontSize:"26px",fontWeight:800}}>{formatAr(currentPrice)}</span>
{lastChange && (
<>
<span style={{
  fontSize:"15px",
  fontWeight:700,
  color: lastChange.type_variation === "augmentation" ? "#c0392b"
    : lastChange.type_variation === "diminution" ? "#1f8a4c"
    : "#6b776f",
}}>
{lastChange.type_variation === "augmentation" ? "▲ +" : lastChange.type_variation === "diminution" ? "▼ -" : ""}
{Math.abs(Number(lastChange.pourcentage_variation) || 0)} %
</span>
<span style={{fontSize:"14px",color:"#8a938d",textDecoration:"line-through",fontWeight:600}}>
{formatAr(Number(lastChange.ancien_prix))}
</span>
</>
)}
</div>

{/* La liste des villes/régions n'est plus répétée ici : chaque offre
    ci-dessous affiche déjà son fournisseur, sa ville/région, son prix,
    etc. — l'avoir en double au-dessus encombrait la fiche pour rien. */}

<div style={{marginTop:"12px",display:"flex",flexDirection:"column",gap:"6px"}}>
{sortedOffers.map((offer, index) => {
  const offerDate = formatOfferDate(offer.date_prix);
  const details = [offerLocation(offer), offer.disponibilite, offer.livraison, offerDate].filter(Boolean).join(" · ");
  return (
    <div key={index} style={{textAlign:"center"}}>
      <span style={{fontWeight:700,fontSize:"14.5px"}}>
        {offer.fournisseur || "Fournisseur non renseigné"} — {formatAr(Number(offer.prix || 0))}
        {index === 0 && sortedOffers.length > 1 ? " (le moins cher)" : ""}
      </span>
      {details && (
        <div style={{fontSize:"12px",color:"#6b776f"}}>{details}</div>
      )}
    </div>
  );
})}
</div>

</div>

</div>

{caracteristiques.length === 0 && (
<p className="text-gray-500" style={{fontSize:"13px",marginTop:"10px"}}>
Aucune caractéristique enregistrée.
</p>
)}

<ul className="bulletList">

{caracteristiques.map((item, index) => (
<li key={`c-${index}`}>
<span className="bLabel">{item.label}</span> : <span className="bValue">{item.valeur}</span>
</li>
))}

<li>
<span className="bLabel">Unité d'achat</span> : <span className="bValue">
{price.unite || "—"}{price.unite_achat ? ` (vendu par ${price.unite_achat})` : ""}
</span>
</li>

<li>
<span className="bLabel">Source</span> : <span className="bValue">{price.prix_source || "—"}</span>
</li>

</ul>

<p style={{fontSize:"11px",color:"var(--muted)",marginTop:"14px"}}>
Toutes ces informations sont utilisées par la recherche en haut de la bibliothèque.
</p>

<button className="ghostButton mt-5" onClick={()=>setOpen(false)}>
Fermer
</button>

</div>

</div>,

document.body,

)}

</>

)

}
