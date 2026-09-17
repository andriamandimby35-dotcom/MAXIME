"use client";

import { useState } from "react";
import { formatAr } from "@/components/money";

type SharedPrice = { id: string; designation: string; categorie: string | null; unite: string; prix_unitaire: number; provenance_label: string; contributor_organization_name: string | null; supplier_name: string | null };
type Observation = { id: string; prix_unitaire: number; provenance_label: string; contributor_organization_name: string | null; supplier_name: string | null; observed_at: string };

export function SharedPriceCatalog({ prices }: { prices: SharedPrice[] }) {
  const [details, setDetails] = useState<{ material: SharedPrice; observations: Observation[] } | null>(null);
  const [message, setMessage] = useState("");

  async function openDetails(id: string) {
    setMessage("Chargement du détail…");
    const response = await fetch(`/api/shared-material-prices/${id}`);
    const payload = await response.json();
    if (!response.ok) { setMessage(payload.error || "Détail indisponible."); return; }
    setDetails(payload);
    setMessage("");
  }

  async function deleteMaterial() {
    if (!details || !window.confirm(`Supprimer « ${details.material.designation} » et tout son historique de prix ?`)) return;
    const response = await fetch(`/api/shared-material-prices/${details.material.id}`, { method: "DELETE" });
    const payload = await response.json();
    if (!response.ok) { setMessage(payload.error || "Suppression impossible."); return; }
    window.location.reload();
  }

  return (
    <section className="sharedPriceBox">

      <h2 className="font-bold text-lg">Prix partagés de référence</h2>

      <p className="mt-1 text-sm text-gray-600">
        Un seul matériau, avec tous ses prix et leurs provenances. Le meilleur prix est affiché ; les détails gardent l&apos;historique complet.
      </p>

      {message && <p className="notice mt-3" style={{padding:"10px 14px"}}>{message}</p>}

      <div className="sharedPriceGrid">
        {prices.length ? prices.map((price) => (
          <article key={price.id} className="sharedPriceCard">

            <strong>{price.designation}</strong>

            <p className="meta">{price.categorie || "Matériau"} · {price.unite}</p>

            <p className="value">{formatAr(Number(price.prix_unitaire))}</p>

            <p className="provenance">Provenance : {price.provenance_label}</p>

            {price.contributor_organization_name && <p className="provenance">Entreprise : {price.contributor_organization_name}</p>}

            {price.supplier_name && <p className="provenance">Fournisseur : {price.supplier_name}</p>}

            <button type="button" className="ghostButton mt-3" onClick={() => void openDetails(price.id)}>
              Détail du matériau
            </button>

          </article>
        )) : <p className="text-sm text-gray-600">Aucun prix partagé pour le moment.</p>}
      </div>

      {details && (
        <div className="sharedPriceDetail">

          <div className="flex items-center justify-between gap-3">

            <div>
              <h3 className="font-bold">{details.material.designation} — historique des prix</h3>
              <p className="text-sm text-gray-600">Premier prix, évolutions et contributeurs.</p>
            </div>

            <div className="flex gap-2">
              <button type="button" className="ghostButton" onClick={() => setDetails(null)}>Fermer</button>
              <button type="button" className="dangerButton" onClick={() => void deleteMaterial()}>Supprimer le matériau</button>
            </div>

          </div>

          <div className="tablePanel mt-3" style={{border:"1px solid var(--line)",borderRadius:"12px"}}>
            <table>
              <thead>
                <tr><th>Date</th><th>Prix</th><th>Évolution</th><th>Provenance</th><th>Entreprise</th></tr>
              </thead>
              <tbody>
                {details.observations.map((entry, index) => {
                  const previous = index ? Number(details.observations[index - 1].prix_unitaire) : null;
                  const percentage = previous && previous > 0 ? ((Number(entry.prix_unitaire) - previous) / previous) * 100 : null;
                  return (
                    <tr key={entry.id}>
                      <td data-label="Date">{new Date(entry.observed_at).toLocaleDateString("fr-FR")}</td>
                      <td data-label="Prix">{formatAr(Number(entry.prix_unitaire))}</td>
                      <td data-label="Évolution" className={percentage === null ? "" : percentage > 0 ? "variationUp" : percentage < 0 ? "variationDown" : ""}>
                        {percentage === null ? "Premier prix" : `${percentage > 0 ? "+" : ""}${percentage.toFixed(2)} %`}
                      </td>
                      <td data-label="Provenance">{entry.provenance_label}{entry.supplier_name ? ` — ${entry.supplier_name}` : ""}</td>
                      <td data-label="Entreprise">{entry.contributor_organization_name || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

        </div>
      )}

    </section>
  );
}
