"use client";

import { useEffect, useState } from "react";
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

export default function PriceCard({price}:{price:any}){

const [open,setOpen] = useState(false);
const [history,setHistory] = useState<PriceHistoryEntry[] | null>(null);
const [historyError,setHistoryError] = useState("");
const loadingHistory = open && history === null && !historyError;

const currentPrice = Number(price.prix_retenu || price.prix_actuel || price.prix_ia || 0);
const isIa = price.statut_prix === "ia";
const confidencePercent = Math.round(Number(price.confiance_ia || 0) * 100);

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

{open && (

<div className="modalBackdrop" onClick={()=>setOpen(false)}>

<div className="modal" onClick={(e)=>e.stopPropagation()}>

<h2 className="font-bold text-xl">
{price.designation}
</h2>

<p className="mt-1 text-gray-500">
{price.categorie} · {price.unite}
</p>

{price.unite_achat && price.quantite_par_unite_achat && price.prix_unite_achat && (
<p className="mt-1 text-gray-500">
Vendu par {price.unite_achat} de {price.quantite_par_unite_achat} {price.unite} à {formatAr(Number(price.prix_unite_achat))}/pièce
</p>
)}

<div className="priceDetailGrid">

<div className="priceDetailStat">
<span>Prix actuel</span>
<strong>{formatAr(currentPrice)}</strong>
</div>

<div className="priceDetailStat">
<span>Confiance IA</span>
<strong>{confidencePercent} %</strong>
</div>

<div className="priceDetailStat">
<span>Provenance</span>
<strong>{isIa ? "Prix IA" : "Prix entreprise"}</strong>
</div>

<div className="priceDetailStat">
<span>Fournisseur</span>
<strong>{price.fournisseur || "—"}</strong>
</div>

<div className="priceDetailStat">
<span>Localisation</span>
<strong>{price.ville || price.region || "—"}</strong>
</div>

<div className="priceDetailStat">
<span>Dernière mise à jour</span>
<strong>{price.updated_at ? new Date(price.updated_at).toLocaleDateString("fr-FR") : "—"}</strong>
</div>

</div>

<h3 className="font-bold mt-6 mb-2">
Historique des prix
</h3>

{loadingHistory ? (
  <p className="text-gray-500">Chargement…</p>
) : historyError ? (
  <p className="notice danger" style={{padding:"10px 14px"}}>Erreur : {historyError}</p>
) : history && history.length > 0 ? (
  history.map((item)=>{
    const isUp = item.type_variation === "augmentation";
    const isDown = item.type_variation === "diminution";
    return (
      <div key={item.id} className="priceHistoryRow">
        <div className="flex items-center justify-between gap-3">
          <span>Ancien prix : {formatAr(Number(item.ancien_prix))}</span>
          <span>Nouveau prix : {formatAr(Number(item.nouveau_prix))}</span>
          <span className={isUp ? "variationUp" : isDown ? "variationDown" : ""}>
            {isUp ? "+" : isDown ? "-" : ""}{Math.abs(Number(item.pourcentage_variation) || 0)} %
          </span>
        </div>
        {item.supplier_name && (
          <p className="text-sm text-gray-500 mt-2">Fournisseur : {item.supplier_name}</p>
        )}
        <p className="text-sm text-gray-500 mt-1">
          {new Date(item.date_modification).toLocaleDateString("fr-FR")}
        </p>
      </div>
    );
  })
) : (
  <p className="text-gray-500">Aucun historique pour ce matériau.</p>
)}

<button className="ghostButton mt-5" onClick={()=>setOpen(false)}>
Fermer
</button>

</div>

</div>

)}

</>

)

}
