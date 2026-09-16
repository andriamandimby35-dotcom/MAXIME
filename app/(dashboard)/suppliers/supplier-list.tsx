"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

type Supplier = { key: string; label: string; count: number };

export function SupplierList({ suppliers }: { suppliers: Supplier[] }) {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter((supplier) => supplier.label.toLowerCase().includes(q));
  }, [suppliers, query]);

  return (
    <section>
      <div className="pageHead">
        <div><h1>Fournisseurs</h1><p>Dérivé automatiquement de la bibliothèque de prix.</p></div>
      </div>

      <input
        className="w-full border p-3 rounded-lg"
        placeholder="Rechercher un fournisseur (ex : Batimax)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ marginTop: "16px" }}
      />

      {results.length > 0 ? (
        <div className="supplierGrid">
          {results.map((supplier) => (
            <Link key={supplier.key} href={`/suppliers/${supplier.key}`} className="supplierTile">
              <strong>{supplier.label}</strong>
              <span>{supplier.count} matériau{supplier.count > 1 ? "x" : ""}</span>
            </Link>
          ))}
        </div>
      ) : (
        <p className="emptyState">Aucun fournisseur ne correspond à « {query} ».</p>
      )}
    </section>
  );
}
