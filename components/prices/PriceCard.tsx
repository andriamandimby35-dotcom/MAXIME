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

export default function PriceCard({price}:{price:any}){

const [open,setOpen] = useState(false);
const [history,setHistory] = useState<PriceHistoryEntry[] | null>(null);
const [historyError,setHistoryError] = useState("");

const currentPrice = Number(price.prix_retenu || price.prix_actuel || price.prix_ia || 0);
const isIa = price.statut_prix === "ia";
const confidencePercent = Math.round(Number(price.confiance_ia || 0) * 100);
const caracteristiques: Caracteristique[] = Array.isArray(price.caracteristiques) ? price.caracteristiques : [];

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

const datePrix = price.date_prix || price.updated_at;

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

{lastChange && (
<div className="priceCompareRow">
<span className="newP">Nouveau : {formatAr(Number(lastChange.nouveau_prix ?? currentPrice))}</span>
<span className={
  lastChange.type_variation === "augmentation" ? "pct up"
  : lastChange.type_variation === "diminution" ? "pct down"
  : "pct"
}>
{lastChange.type_variation === "augmentation" ? "+" : lastChange.type_variation === "diminution" ? "-" : ""}
{Math.abs(Number(lastChange.pourcentage_variation) || 0)} %
</span>
<span className="oldP">Ancien : {formatAr(Number(lastChange.ancien_prix))}</span>
</div>
)}

</div>

<div className="sectionLabel">Informations générales</div>
<div className="detailList">

<div className="detailRow">
<span className="label">Catégorie</span>
<span className="value">{price.categorie || "—"}</span>
</div>

<div className="detailRow">
<span className="label">Unité</span>
<span className="value">
{price.unite || "—"}{price.unite_achat ? ` (vendu par ${price.unite_achat})` : ""}
</span>
</div>

<div className="detailRow">
<span className="label">Fournisseur</span>
<span className="value">{price.fournisseur || "—"}</span>
</div>

<div className="detailRow">
<span className="label">Ville</span>
<span className="value">{price.ville || "—"}</span>
</div>

<div className="detailRow">
<span className="label">Région</span>
<span className="value">{price.region || "—"}</span>
</div>

<div className="detailRow">
<span className="label">Disponibilité</span>
<span className="value">{price.disponibilite || "—"}</span>
</div>

<div className="detailRow">
<span className="label">Livraison</span>
<span className="value">{price.livraison || "—"}</span>
</div>

<div className="detailRow">
<span className="label">Date du prix</span>
<span className="value">{datePrix ? new Date(datePrix).toLocaleDateString("fr-FR") : "—"}</span>
</div>

</div>

<div className="sectionLabel">Caractéristiques techniques</div>
<div className="detailList">

{caracteristiques.length > 0 ? caracteristiques.map((item, index) => (
<div className="detailRow" key={index}>
<span className="label">{item.label}</span>
<span className="value">{item.valeur}</span>
</div>
)) : (
<p className="text-gray-500" style={{fontSize:"13px",padding:"9px 2px"}}>
Aucune caractéristique enregistrée.
</p>
)}

</div>

<p style={{fontSize:"11px",color:"var(--muted)",marginTop:"14px"}}>
Toutes ces informations (générales et techniques) sont utilisées par la recherche en haut de la bibliothèque.
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
