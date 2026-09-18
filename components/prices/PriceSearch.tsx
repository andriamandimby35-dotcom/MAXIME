"use client";

import { useMemo, useState } from "react";
import PriceCard from "./PriceCard";
import { supplierGroup, regionGroup } from "@/lib/material-normalization";

type Mode = "nom" | "fournisseur" | "region";
type Drill = { type: "fournisseur" | "region"; key: string; label: string } | null;

function normalize(value: unknown) {
  return String(value ?? "").toLocaleLowerCase("fr-FR");
}

// La recherche englobe tout : nom, fournisseur, ville, région, catégorie,
// unité, disponibilité, livraison, et le libellé/la valeur de chaque
// caractéristique technique (même chose non présente dans le nom).
function matchesQuery(price: any, needle: string) {
  const fields = [
    price.designation, price.fournisseur, price.ville, price.region,
    price.categorie, price.unite, price.disponibilite, price.livraison,
  ];
  if (fields.some((field) => normalize(field).includes(needle))) return true;
  const caracteristiques = Array.isArray(price.caracteristiques) ? price.caracteristiques : [];
  return caracteristiques.some((item: any) =>
    normalize(item?.label).includes(needle) || normalize(item?.valeur).includes(needle)
  );
}

function sortByDesignation(prices: any[]) {
  return [...prices].sort((a, b) => String(a.designation || "").localeCompare(String(b.designation || ""), "fr"));
}

export default function PriceSearch({ prices }: { prices: any[] }) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("nom");
  const [drill, setDrill] = useState<Drill>(null);

  const activeQuery = query.trim();
  const isSearching = activeQuery.length > 0;

  const searchResults = useMemo(() => {
    if (!isSearching) return [];
    const needle = normalize(activeQuery);
    return sortByDesignation(prices.filter((price) => matchesQuery(price, needle)));
  }, [prices, activeQuery, isSearching]);

  const supplierGroups = useMemo(() => {
    const groups = new Map<string, { key: string; label: string }>();
    for (const price of prices) {
      const raw = String(price.fournisseur || "").trim();
      const { key, label } = raw ? supplierGroup(raw, price.ville, price.region) : { key: "autre", label: "Autre" };
      if (!groups.has(key)) groups.set(key, { key, label });
    }
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, "fr"));
  }, [prices]);

  const regionGroups = useMemo(() => {
    const groups = new Map<string, { key: string; label: string }>();
    for (const price of prices) {
      const raw = String(price.region || "").trim();
      const { key, label } = raw ? regionGroup(raw) : { key: "autre", label: "Autre" };
      if (!groups.has(key)) groups.set(key, { key, label });
    }
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, "fr"));
  }, [prices]);

  const drillResults = useMemo(() => {
    if (!drill) return [];
    if (drill.type === "fournisseur") {
      return sortByDesignation(prices.filter((price) => {
        const raw = String(price.fournisseur || "").trim();
        const key = raw ? supplierGroup(raw, price.ville, price.region).key : "autre";
        return key === drill.key;
      }));
    }
    return sortByDesignation(prices.filter((price) => {
      const raw = String(price.region || "").trim();
      const key = raw ? regionGroup(raw).key : "autre";
      return key === drill.key;
    }));
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
        placeholder="Rechercher : nom, fournisseur, ville, région, caractéristique… (ex : Ø12)"
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
