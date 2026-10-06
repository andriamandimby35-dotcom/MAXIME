"use client";

import { useEffect, useState } from "react";
import type { AllocationResult } from "@/lib/expenses/allocation";

type Budget = { categories: Array<{ name: string; budget: number }>; internalOnly: number; missingLines: number; lines: number };

const money = (value: number) => `${Math.round(value).toLocaleString("fr-FR")} Ar`;

// Carte « Budget » : pour chaque catégorie du devis, ce qui a été dépensé
// (classement des dépenses) face à la somme prévue au devis INTERNE.
// Vert : dans le budget · orange : proche de la limite (au-delà de 90 %) ·
// rouge : hors budget · gris : pas de budget prévu pour cette ligne.
export function BudgetByCategoryCard({ projectId, allocation }: { projectId: string; allocation: AllocationResult | null }) {
  const [budget, setBudget] = useState<Budget | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch(`/api/projects/${projectId}/expense-budget`, { cache: "no-store" }).catch(() => null);
      if (!response?.ok) return;
      const data = await response.json().catch(() => null);
      if (!cancelled && data) setBudget(data as Budget);
    })();
    return () => { cancelled = true; };
  }, [projectId, allocation]);

  if (!budget || !allocation) return <p className="projectEmptyText">Calcul du budget en cours…</p>;
  if (budget.lines === 0) return <p className="projectEmptyText">Ce chantier n’a pas encore de devis : pas de budget à comparer.</p>;

  const spentByCategory = new Map(allocation.categories.map((category) => [category.name, category.total]));
  const names = [...new Set([...budget.categories.map((category) => category.name), ...allocation.categories.map((category) => category.name)])];
  const rows = names.map((name) => ({
    name,
    budget: budget.categories.find((category) => category.name === name)?.budget ?? 0,
    spent: spentByCategory.get(name) ?? 0,
  }));
  rows.push({ name: "Autre (non classé)", budget: budget.internalOnly, spent: allocation.other.total });

  const status = (spent: number, planned: number) => {
    if (!(planned > 0)) return { color: "#eef1ee", border: "#c9d2cc", label: spent > 0 ? "Pas de budget prévu" : "—" };
    const ratio = spent / planned;
    if (ratio > 1) return { color: "#fdecec", border: "#e49a9a", label: `Hors budget (+${money(spent - planned)})` };
    if (ratio >= 0.9) return { color: "#fbeee0", border: "#e8b27a", label: `Proche de la limite (${Math.round(ratio * 100)} %)` };
    return { color: "#e5f8eb", border: "#8fd0a5", label: `Dans le budget (${Math.round(ratio * 100)} %)` };
  };

  const totalBudget = rows.reduce((sum, row) => sum + row.budget, 0);
  const totalSpent = rows.reduce((sum, row) => sum + row.spent, 0);
  const total = status(totalSpent, totalBudget);

  return (
    <div>
      <div style={{ background: total.color, border: `1px solid ${total.border}`, borderRadius: "12px", padding: "10px 12px", marginBottom: "8px" }}>
        <strong>Total : {money(totalSpent)} dépensé sur {money(totalBudget)} prévu</strong>
        <div style={{ fontSize: ".82rem" }}>{total.label}</div>
      </div>
      <div style={{ display: "grid", gap: "6px" }}>
        {rows.filter((row) => row.budget > 0 || row.spent > 0).map((row) => {
          const info = status(row.spent, row.budget);
          return (
            <div key={row.name} style={{ background: info.color, border: `1px solid ${info.border}`, borderRadius: "10px", padding: "8px 10px", display: "flex", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
              <div><strong>{row.name}</strong><div style={{ fontSize: ".76rem", color: "#4b5b52" }}>{info.label}</div></div>
              <div style={{ textAlign: "right", fontSize: ".85rem" }}>{money(row.spent)} <span style={{ color: "#667" }}>/ {row.budget > 0 ? money(row.budget) : "—"}</span></div>
            </div>
          );
        })}
      </div>
      {budget.missingLines > 0 && (
        <p className="projectHint" style={{ marginTop: "8px" }}>⚠ {budget.missingLines} ligne(s) du devis n’ont pas encore de prix interne : le budget est incomplet. Va dans le menu Devis, « Remplir les prix (IA) ».</p>
      )}
      <p className="projectHint" style={{ marginTop: "6px" }}>Légende : vert dans le budget · orange proche de la limite · rouge hors budget · gris pas de budget prévu.</p>
    </div>
  );
}
