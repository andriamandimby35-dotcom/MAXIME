"use client";

import { useMemo, useState } from "react";
import PriceCard from "./PriceCard";

export default function PriceSearch({ prices }: { prices: any[] }) {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? prices.filter((price) => (price.designation || "").toLowerCase().includes(q)) : prices;
    return [...filtered].sort((a, b) => String(a.designation || "").localeCompare(String(b.designation || ""), "fr"));
  }, [prices, query]);

  return (
    <div className="w-full">
      <input
        className="w-full border p-3 rounded-lg"
        placeholder="Rechercher un matériau (ex : CI pour ciment)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="mt-4">
        {results.length > 0 ? (
          <div className="priceGrid">
            {results.map((price) => <PriceCard key={price.id} price={price} />)}
          </div>
        ) : (
          <p className="text-gray-500">
            {query.trim() === "" ? "Aucun prix enregistré." : `Aucun matériau ne commence par « ${query} ».`}
          </p>
        )}
      </div>
    </div>
  );
}
