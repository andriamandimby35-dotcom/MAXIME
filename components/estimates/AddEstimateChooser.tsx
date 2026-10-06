"use client";

import Link from "next/link";
import { useState } from "react";

// Bouton « + Ajouter un devis » : deux choix, Interne ou Externe.
// - Interne : depuis un DAO analysé (comme avant) ou depuis un PDF (coûts).
// - Externe : depuis un PDF avec les prix du client.
export function AddEstimateChooser() {
  const [open, setOpen] = useState(false);
  const [internalOpen, setInternalOpen] = useState(false);
  const card: React.CSSProperties = { flex: "1 1 220px", minWidth: "220px", border: "1px solid #cfe1d4", borderRadius: "14px", padding: "14px", background: "#fff" };
  return (
    <div style={{ position: "relative" }}>
      <button type="button" className="tenderButton tenderButtonPrimary tenderAddButton" onClick={() => { setOpen((value) => !value); setInternalOpen(false); }}>+ Ajouter un devis</button>
      {open && (
        <div className="panel" style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", zIndex: 20, width: "min(560px, 92vw)", display: "flex", gap: "12px", flexWrap: "wrap", padding: "14px", boxShadow: "0 10px 30px rgba(0,0,0,.18)" }}>
          <div style={card}>
            <strong>Devis interne</strong>
            <p style={{ fontSize: ".8rem", color: "#555", margin: "6px 0 10px" }}>Tes coûts. La marge fabrique le devis externe (celui du client) et la facturation.</p>
            {!internalOpen ? (
              <button type="button" className="tenderButton" onClick={() => setInternalOpen(true)}>Choisir…</button>
            ) : (
              <div style={{ display: "grid", gap: "6px" }}>
                <Link className="tenderButton" href="/estimates/new" onClick={() => setOpen(false)}>Depuis un DAO analysé</Link>
                <Link className="tenderButton" href="/estimates/import?kind=internal" onClick={() => setOpen(false)}>Depuis un PDF</Link>
              </div>
            )}
          </div>
          <div style={card}>
            <strong>Devis externe</strong>
            <p style={{ fontSize: ".8rem", color: "#555", margin: "6px 0 10px" }}>Les prix du client. Il sert directement à la facturation et au planning ; le devis interne en est tiré.</p>
            <Link className="tenderButton tenderButtonPrimary" href="/estimates/import?kind=external" onClick={() => setOpen(false)}>Depuis un PDF</Link>
          </div>
        </div>
      )}
    </div>
  );
}
