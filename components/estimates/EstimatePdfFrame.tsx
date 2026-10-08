"use client";

// PDF affiché dans la carte d'un devis (liste des devis), sous les boutons, avec « Fermer ».
export function EstimatePdfFrame({ title, url, onClose }: { title: string; url: string; onClose: () => void }) {
  return (
    <div style={{ flexBasis: "100%", width: "100%", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 6, minWidth: 0 }}>
        <strong style={{ fontSize: ".9rem", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</strong>
        <button type="button" className="tenderButton" onClick={onClose}>Fermer</button>
      </div>
      <iframe src={url} title={title} style={{ width: "100%", height: "70vh", minHeight: 420, border: "1px solid #b8d7c0", borderRadius: 8, background: "#fff" }} />
    </div>
  );
}
