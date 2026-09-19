"use client";

import { useMemo, useState } from "react";
import PriceCard from "./PriceCard";
import { supplierGroup, regionGroup } from "@/lib/material-normalization";

type Mode = "nom" | "fournisseur" | "region";
type Drill = { type: "fournisseur" | "region"; key: string; label: string } | null;

function normalize(value: unknown) {
  let text = String(value ?? "").toLocaleLowerCase("fr-FR");
  // Mêmes équivalences que la bibliothèque de prix (voir lib/material-normalization.ts) :
  // "D20" et "Ø20", "40x40" et "40×40" doivent être trouvés pareil, même si
  // le nom exact dans la bibliothèque utilise l'autre écriture.
  text = text.replace(/ø(?=\d)/g, "d");
  text = text.replace(/(\d)\s*[×x]\s*(\d)/g, "$1x$2");
  // Retire les accents : "beton" doit trouver "béton", "generateur" doit
  // trouver "générateur", peu importe les accents tapés ou non.
  text = text.normalize("NFD").replace(/[̀-ͯ]/g, "");
  // Retire la ponctuation qui gêne la recherche (trait d'union, point,
  // virgule, apostrophe, parenthèses, slash...) : "B-P", "B.P." et "BP"
  // doivent tous être trouvés pareil, et "22,5" / "22.5" / "225" aussi.
  text = text.replace(/[-_.,'’"()/\\]/g, "");
  return text;
}

// La recherche englobe tout : nom, fournisseur, ville, région, catégorie,
// unité, disponibilité, livraison, et le libellé/la valeur de chaque
// caractéristique technique (même chose non présente dans le nom).
function buildSearchableText(price: any) {
  const fields = [
    price.designation, price.fournisseur, price.ville, price.region,
    price.categorie, price.unite, price.disponibilite, price.livraison,
  ];
  const caracteristiques = Array.isArray(price.caracteristiques) ? price.caracteristiques : [];
  for (const item of caracteristiques) {
    fields.push(item?.label, item?.valeur);
  }
  return normalize(fields.filter(Boolean).join(" "));
}

// Recherche par mots-clés : "fer 6" trouve tout matériau qui contient à la
// fois "fer" ET "6" quelque part (peu importe l'ordre ou le champ), et pas
// seulement les matériaux qui contiennent la phrase exacte "fer 6".
function matchesQuery(price: any, tokens: string[]) {
  const haystack = buildSearchableText(price);
  return tokens.every((token) => haystack.includes(token));
}

function sortByDesignation(prices: any[]) {
  return [...prices].sort((a, b) => String(a.designation || "").localeCompare(String(b.designation || ""), "fr"));
}

// Un matériau peut avoir plusieurs offres (fournisseurs/villes/régions
// différentes) dans son tableau "fournisseurs" — les champs fournisseur/
// ville/region au premier niveau ne reflètent que l'offre la moins chère.
// Pour que le regroupement par fournisseur ou par région (et le clic dessus)
// trouve TOUTES les offres d'un matériau, et pas seulement la moins chère,
// on parcourt ici la liste complète des offres (avec un repli sur les champs
// de premier niveau pour les anciennes fiches sans tableau "fournisseurs").
function offersOf(price: any): Array<{ fournisseur?: string; ville?: string; region?: string }> {
  return Array.isArray(price.fournisseurs) && price.fournisseurs.length > 0
    ? price.fournisseurs
    : [{ fournisseur: price.fournisseur, ville: price.ville, region: price.region }];
}

export default function PriceSearch({ prices }: { prices: any[] }) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("nom");
  const [drill, setDrill] = useState<Drill>(null);

  const activeQuery = query.trim();
  const isSearching = activeQuery.length > 0;

  const searchResults = useMemo(() => {
    if (!isSearching) return [];
    const tokens = normalize(activeQuery).split(/\s+/).filter(Boolean);
    return sortByDesignation(prices.filter((price) => matchesQuery(price, tokens)));
  }, [prices, activeQuery, isSearching]);

  // Une offre sans fournisseur/région renseignée n'est plus mise dans un
  // groupe fourre-tout "Autre" : elle est simplement ignorée pour ce mode
  // d'affichage (le matériau reste bien sûr trouvable via "Nom" ou la
  // recherche).
  const supplierGroups = useMemo(() => {
    const groups = new Map<string, { key: string; label: string }>();
    for (const price of prices) {
      for (const offer of offersOf(price)) {
        const raw = String(offer.fournisseur || "").trim();
        if (!raw) continue;
        const { key, label } = supplierGroup(raw, offer.ville, offer.region);
        if (!groups.has(key)) groups.set(key, { key, label });
      }
    }
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, "fr"));
  }, [prices]);

  const regionGroups = useMemo(() => {
    const groups = new Map<string, { key: string; label: string }>();
    for (const price of prices) {
      for (const offer of offersOf(price)) {
        const raw = String(offer.region || "").trim();
        if (!raw) continue;
        const { key, label } = regionGroup(raw);
        if (!groups.has(key)) groups.set(key, { key, label });
      }
    }
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, "fr"));
  }, [prices]);

  // Un matériau appartient à une région (ou un fournisseur) dès qu'UNE de ses
  // offres correspond — donc il peut apparaître dans plusieurs régions à la
  // fois si plusieurs fournisseurs le proposent dans des régions différentes.
  const drillResults = useMemo(() => {
    if (!drill) return [];
    if (drill.type === "fournisseur") {
      return sortByDesignation(prices.filter((price) =>
        offersOf(price).some((offer) => {
          const raw = String(offer.fournisseur || "").trim();
          return raw && supplierGroup(raw, offer.ville, offer.region).key === drill.key;
        }),
      ));
    }
    return sortByDesignation(prices.filter((price) =>
      offersOf(price).some((offer) => {
        const raw = String(offer.region || "").trim();
        return raw && regionGroup(raw).key === drill.key;
      }),
    ));
  }, [prices, drill]);

  function selectMode(next: Mode) {
    setQuery("");
    setDrill(null);
    setMode(next);
  }

  function openDrill(type: "fournisseur" | "region", key: string, label: string) {
    setDrill({ type, key, label });
  }

  let resultsHead = "";
  if (isSearching) resultsHead = `Résultats pour « ${activeQuery} »`;
  else if (drill) resultsHead = `Matériaux — ${drill.label}`;
  else if (mode === "fournisseur") resultsHead = "Tous les fournisseurs disponibles";
  else if (mode === "region") resultsHead = "Toutes les régions disponibles";
  else resultsHead = "Tous les matériaux, par nom";

  return (
    <div className="w-full">
      <input
        className="w-full border p-3 rounded-lg"
        placeholder="Rechercher : un ou plusieurs mots-clés (ex : fer 6, sac ciment 50)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="modeRow">
        <button
          type="button"
          className={!isSearching && !drill && mode === "fournisseur" ? "modeBtn active" : "modeBtn"}
          onClick={() => selectMode("fournisseur")}
        >
          Fournisseur
        </button>
        <button
          type="button"
          className={!isSearching && !drill && mode === "region" ? "modeBtn active" : "modeBtn"}
          onClick={() => selectMode("region")}
        >
          Région
        </button>
        <button
          type="button"
          className={!isSearching && !drill && mode === "nom" ? "modeBtn active" : "modeBtn"}
          onClick={() => selectMode("nom")}
        >
          Nom
        </button>
      </div>

      <p className="resultsHead">{resultsHead}</p>

      <div className="mt-2">
        {isSearching ? (
          searchResults.length > 0 ? (
            <div className="priceGrid">
              {searchResults.map((price) => <PriceCard key={price.id} price={price} />)}
            </div>
          ) : (
            <p className="text-gray-500">Aucun matériau ne correspond à « {activeQuery} ».</p>
          )
        ) : drill ? (
          <>
            <button type="button" className="tenderBackLink" onClick={() => setDrill(null)}>
              ← Retour
            </button>
            {drillResults.length > 0 ? (
              <div className="priceGrid">
                {drillResults.map((price) => <PriceCard key={price.id} price={price} />)}
              </div>
            ) : (
              <p className="text-gray-500">Aucun matériau enregistré ici.</p>
            )}
          </>
        ) : mode === "fournisseur" ? (
          supplierGroups.length > 0 ? (
            <div className="supplierGrid">
              {supplierGroups.map((supplier) => (
                <button
                  type="button"
                  key={supplier.key}
                  className="supplierTile"
                  style={{ textAlign: "left", cursor: "pointer" }}
                  onClick={() => openDrill("fournisseur", supplier.key, supplier.label)}
                >
                  <strong>{supplier.label}</strong>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-gray-500">Aucun fournisseur enregistré.</p>
          )
        ) : mode === "region" ? (
          regionGroups.length > 0 ? (
            <div className="supplierGrid">
              {regionGroups.map((region) => (
                <button
                  type="button"
                  key={region.key}
                  className="supplierTile"
                  style={{ textAlign: "left", cursor: "pointer" }}
                  onClick={() => openDrill("region", region.key, region.label)}
                >
                  <strong>{region.label}</strong>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-gray-500">Aucune région enregistrée.</p>
          )
        ) : (
          sortByDesignation(prices).length > 0 ? (
            <div className="priceGrid">
              {sortByDesignation(prices).map((price) => <PriceCard key={price.id} price={price} />)}
            </div>
          ) : (
            <p className="text-gray-500">Aucun prix enregistré.</p>
          )
        )}
      </div>
    </div>
  );
}
