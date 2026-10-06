"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatAr } from "@/components/money";

export type ImportedDevis = {
  id: string;
  name: string;
  createdAt: string | null;
  lines: number;
  internalTotal: number;
  externalTotal: number;
  missingInternal: number;
  missingExternal: number;
  marginPercent: number | null;
};

type Missing = { id: string; designation: string; unit: string; quantity: number; category: string };

// Devis ajoutés par PDF (ou chantiers dont le devis n'a que les prix externes) :
// remplissage des prix internes manquants par la recherche de prix (bibliothèque
// puis internet, comme pour un devis du DAO), puis marge calculée ou appliquée.
export function ImportedDevisTable({ rows }: { rows: ImportedDevis[] }) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<{ id: string; current: number; total: number; label: string } | null>(null);
  const [margins, setMargins] = useState<Record<string, string>>({});
  const stopRef = useRef(false);

  async function applyMargin(row: ImportedDevis, marginValue?: string) {
    const response = await fetch(`/api/devis/projects/${row.id}/margin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ margin_percent: marginValue ?? null }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { setMessage(result.error ?? "Marge non enregistrée."); return false; }
    setMessage(result.marginPercent !== null && result.marginPercent !== undefined
      ? `Marge de « ${row.name} » : ${Number(result.marginPercent).toLocaleString("fr-FR")} %.`
      : `Marge de « ${row.name} » : pas encore calculable (il manque des prix).`);
    return true;
  }

  async function fillInternalPrices(row: ImportedDevis) {
    setMessage("");
    const listResponse = await fetch(`/api/devis/projects/${row.id}/prices`, { cache: "no-store" });
    const list = await listResponse.json().catch(() => ({}));
    if (!listResponse.ok) { setMessage(list.error ?? "Lecture du devis impossible."); return; }
    const missing = (list.missing ?? []) as Missing[];
    if (missing.length === 0) { setMessage("Tous les prix internes sont déjà remplis."); return; }
    if (!window.confirm(`${missing.length} prix interne(s) vont être cherchés (bibliothèque de prix, puis internet). Cela utilise des crédits IA. Lancer ?`)) return;

    stopRef.current = false;
    let pending: Array<{ id: string; unit_price: number }> = [];
    let found = 0;
    let notFound = 0;
    let failed = "";
    const flush = async () => {
      if (pending.length === 0) return;
      const batch = pending; pending = [];
      const response = await fetch(`/api/devis/projects/${row.id}/prices`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ updates: batch }) });
      if (!response.ok) { const result = await response.json().catch(() => ({})); failed = result.error ?? "Enregistrement des prix impossible."; }
    };

    for (let index = 0; index < missing.length; index += 1) {
      if (stopRef.current || failed) break;
      const line = missing[index];
      setProgress({ id: row.id, current: index + 1, total: missing.length, label: line.designation });
      if (!line.designation || !line.unit) { notFound += 1; continue; }
      try {
        const response = await fetch("/api/prices/internet-search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            designation: line.designation,
            categorie: line.category,
            unite: line.unit,
            daoQuantity: line.quantity,
            pricingContext: "",
            worksiteName: row.name,
            worksiteLocation: "",
          }),
        });
        const result = await response.json().catch(() => ({})) as { error?: string; found?: boolean; selected_price?: number };
        if (!response.ok) { failed = result.error || "La recherche de prix est momentanément indisponible."; break; }
        const price = Number(result.selected_price);
        if (result.found && Number.isFinite(price) && price > 0) { pending.push({ id: line.id, unit_price: price }); found += 1; }
        else notFound += 1;
      } catch {
        failed = "Connexion interrompue pendant la recherche des prix.";
        break;
      }
      if (pending.length >= 5) await flush();
    }
    await flush();
    setProgress(null);
    // Marge : calculée (devis externe) ou appliquée avec la marge déjà retenue (devis interne).
    await applyMargin(row);
    setMessage(`« ${row.name} » : ${found} prix trouvé(s), ${notFound} à saisir ou à relancer${failed ? ` — arrêt : ${failed}` : stopRef.current ? " — arrêté à ta demande" : ""}.`);
    router.refresh();
  }

  async function applyGivenMargin(row: ImportedDevis) {
    const value = margins[row.id] ?? "";
    if (!value.trim()) { setMessage("Indique la marge à appliquer (en %)."); return; }
    if (await applyMargin(row, value)) router.refresh();
  }

  if (rows.length === 0) return null;
  const small: React.CSSProperties = { fontSize: ".75rem", color: "#666" };
  return (
    <section className="panel tablePanel" style={{ marginTop: "20px" }}>
      <div style={{ padding: "14px 16px 0" }}>
        <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Devis ajoutés par PDF</h2>
        <p style={small}>Chaque devis garde deux côtés : le prix externe (client, utilisé pour la facture) et le prix interne (ton coût, utilisé pour le budget). La marge est externe ÷ interne − 1.</p>
      </div>
      {message && <p className="notice" style={{ margin: "8px 16px" }}>{message}</p>}
      <table>
        <thead><tr><th>Chantier</th><th>Coût interne</th><th>Marge</th><th>Montant externe</th><th>À compléter</th><th>Actions</th></tr></thead>
        <tbody>
          {rows.map((row) => {
            const running = progress?.id === row.id;
            const canGiveMargin = row.missingExternal > 0 && row.lines - row.missingInternal > 0;
            return (
              <tr key={row.id}>
                <td><strong>{row.name}</strong><br /><small>{row.createdAt ? new Date(row.createdAt).toLocaleDateString("fr-FR") : ""} · {row.lines} lignes</small></td>
                <td>{row.internalTotal > 0 ? formatAr(row.internalTotal) : "—"}{row.missingInternal > 0 && row.internalTotal > 0 ? <><br /><small>(partiel)</small></> : null}</td>
                <td>{row.marginPercent !== null ? `${row.marginPercent.toLocaleString("fr-FR")} %` : "—"}</td>
                <td>{row.externalTotal > 0 ? formatAr(row.externalTotal) : "—"}</td>
                <td>
                  {row.missingInternal > 0 ? <div>{row.missingInternal} prix interne(s)</div> : <div style={{ color: "#1f7a46" }}>Prix internes complets</div>}
                  {row.missingExternal > 0 ? <div>{row.missingExternal} prix externe(s)</div> : null}
                  {running && progress && <div style={small}>Recherche {progress.current}/{progress.total} : {progress.label}</div>}
                </td>
                <td>
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                    {row.missingInternal > 0 && !running && <button type="button" className="tenderButton tenderButtonPrimary" disabled={Boolean(progress)} onClick={() => void fillInternalPrices(row)}>Remplir les prix (IA)</button>}
                    {running && <button type="button" className="tenderButton" onClick={() => { stopRef.current = true; }}>Arrêter</button>}
                    {canGiveMargin && (
                      <span style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}>
                        <input type="number" step="0.1" placeholder="Marge %" style={{ width: "88px" }} value={margins[row.id] ?? ""} onChange={(event) => setMargins((current) => ({ ...current, [row.id]: event.target.value }))} />
                        <button type="button" className="tenderButton" disabled={Boolean(progress)} onClick={() => void applyGivenMargin(row)}>Appliquer</button>
                      </span>
                    )}
                    <Link className="tenderButton" href={`/billing/${row.id}`}>Facturation</Link>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
