"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatDate } from "@/components/money";

const TYPE_LABELS: Record<string, string> = { dao: "DAO", plan: "PLAN", estimate: "DEVIS", report: "RAPPORT", photo: "PHOTO CHANTIER", other: "AUTRE" };

// Documents en cartes cliquables (comme le reste de l'application) : un clic
// ouvre le fichier dans un nouvel onglet. Le lien privé n'est demandé qu'au
// clic, donc aucun transfert Supabase tant qu'on n'ouvre pas le document.
export function DocumentManager({ organizationId, userId, initialRows }: { organizationId: string | null; userId: string | null; initialRows: any[] }) {
  const [rows, setRows] = useState(initialRows);
  const [busy, setBusy] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => setRows(initialRows), [initialRows]);
  const sb = useMemo(() => createClient(), []);

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || !userId) return;
    setBusy(true);
    setError("");
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("file") as File;
    const type = String(data.get("type"));
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${organizationId}/${type}/${crypto.randomUUID()}-${safe}`;
    const up = await sb.storage.from("btp-documents").upload(path, file);
    if (up.error) { setError(up.error.message); setBusy(false); return; }
    const inserted = await sb.from("documents").insert({ organization_id: organizationId, name: file.name, document_type: type, storage_path: path, mime_type: file.type, file_size: file.size, uploaded_by: userId }).select().single();
    if (inserted.error) { setError(inserted.error.message); setBusy(false); return; }
    setRows([inserted.data, ...rows]);
    form.reset();
    setBusy(false);
  }

  async function openDocument(row: any) {
    if (!row.storage_path) { setError("Ce document n'a pas de fichier associé."); return; }
    setError("");
    const preview = window.open("about:blank", "_blank");
    setOpeningId(row.id);
    const signed = await sb.storage.from("btp-documents").createSignedUrl(row.storage_path, 300);
    setOpeningId(null);
    if (signed.error || !signed.data?.signedUrl) {
      preview?.close();
      setError(signed.error?.message ?? "Ouverture du document impossible.");
      return;
    }
    if (preview) preview.location.replace(signed.data.signedUrl);
    else window.location.assign(signed.data.signedUrl);
  }

  return <div className="stack">
    <div className="pageHead"><div><h1>Documents</h1><p>DAO, plans, devis, photos et rapports dans un stockage privé.</p></div></div>
    <form className="panel upload" onSubmit={upload}>
      <label>Fichier<input name="file" type="file" required /></label>
      <label>Catégorie<select name="type"><option value="dao">DAO</option><option value="plan">Plan</option><option value="estimate">Devis</option><option value="report">Rapport</option><option value="photo">Photo chantier</option><option value="other">Autre</option></select></label>
      <button className="button" disabled={busy}>{busy ? "Téléversement…" : "Téléverser"}</button>
      {error && <div className="notice danger">{error}</div>}
    </form>
    {rows.length === 0
      ? <section className="projectEmptyCard"><h2>Aucun document</h2><p>Téléversez un fichier avec le formulaire ci-dessus.</p></section>
      : <section className="projectDirectoryGrid" aria-label="Documents">
        {rows.map((row: any) => (
          <div
            key={row.id}
            className="projectDirectoryCard"
            style={{ cursor: openingId === row.id ? "wait" : "pointer", minHeight: 200 }}
            role="button"
            tabIndex={0}
            onClick={() => void openDocument(row)}
            onKeyDown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) void openDocument(row); }}
          >
            <span className="projectCardLabel">{TYPE_LABELS[String(row.document_type)] ?? String(row.document_type ?? "DOCUMENT").toUpperCase()}</span>
            <h2 style={{ fontSize: "1.2rem", wordBreak: "break-word" }}>{row.name}</h2>
            <div className="projectCardMetrics" style={{ gridTemplateColumns: "repeat(2,minmax(0,1fr))" }}>
              <span><strong style={{ fontSize: ".9rem" }}>{formatDate(row.created_at)}</strong>ajouté le</span>
              <span><strong style={{ fontSize: ".9rem" }}>{row.file_size ? `${Math.round(row.file_size / 1024)} Ko` : "—"}</strong>taille</span>
            </div>
            <span className="projectOpenButton">{openingId === row.id ? "Ouverture…" : "Ouvrir le document →"}</span>
          </div>
        ))}
      </section>}
  </div>;
}
