"use client";

import { useState } from "react";

// Mêmes champs que ceux déjà utilisés dans les dossiers de soumission DAO
// (voir components/tenders/SubmissionDossierManager.tsx) : on ne les modifie
// pas là-bas pour ne rien casser, mais un même champ (ex: "nif") représente
// bien la même information des deux côtés.
const profileFields = [
  ["legal_name", "Raison sociale"], ["trade_name", "Nom commercial"],
  ["legal_form", "Forme juridique"],
  ["representative_name", "Représentant légal"], ["representative_role", "Fonction du représentant"],
  ["address", "Adresse"], ["phone", "Téléphone"], ["email", "E-mail"],
  ["nif", "NIF"], ["stat", "STAT"], ["rcs", "RCS / registre de commerce"],
  ["bank_name", "Banque"], ["bank_agency", "Agence bancaire"], ["bank_phone", "Téléphone de la banque"],
  ["bank_address", "Adresse de la banque"], ["bank_account", "IBAN"],
] as const;

export function CompanyProfileForm({ initialProfile }: { initialProfile: Record<string, string> }) {
  const [profile, setProfile] = useState<Record<string, string>>(initialProfile);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  function updateField(key: string, value: string) {
    setProfile((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    setBusy(true); setMessage("");
    const response = await fetch("/api/organization/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile }),
    });
    const result = await response.json();
    setBusy(false);
    if (!response.ok) return setMessage(result.error ?? "Enregistrement impossible.");
    setMessage("Profil enregistré.");
  }

  return (
    <div className="panel">
      <p style={{ marginTop: 0, color: "#666" }}>
        Ces informations servent à pré-remplir automatiquement tes devis, tes factures et tes dossiers de soumission — plus besoin de les ressaisir à chaque fois.
      </p>
      <div className="formGrid">
        {profileFields.map(([key, label]) => (
          <label key={key}>
            {label}
            <input value={profile[key] ?? ""} onChange={(event) => updateField(key, event.target.value)} />
          </label>
        ))}
      </div>
      {message && <p className="notice" style={{ marginTop: "12px" }}>{message}</p>}
      <div style={{ marginTop: "14px" }}>
        <button type="button" className="button" disabled={busy} onClick={() => void save()}>{busy ? "Enregistrement…" : "Enregistrer"}</button>
      </div>
    </div>
  );
}
