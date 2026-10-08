// Ouvre un PDF de devis dans un nouvel onglet SANS le télécharger ni l'enregistrer :
// le serveur renvoie le PDF encodé, le navigateur le reconstruit en local
// (aucun stockage Supabase, aucun transfert répété).
export async function openDevisPdf(url: string, body: Record<string, unknown>): Promise<string | null> {
  const preview = window.open("about:blank", "_blank");
  if (!preview) return "Le navigateur a bloqué la fenêtre PDF. Autorisez les fenêtres surgissantes puis réessayez.";
  preview.document.title = "Préparation du PDF…";
  preview.document.body.innerHTML = "<p style='font-family:system-ui;padding:24px'>Préparation du PDF…</p>";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PDF-Client-Fetch": "1" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({})) as { pdfBase64?: string; error?: string };
    if (!response.ok || !payload.pdfBase64) throw new Error(payload.error || "Le PDF ne peut pas être ouvert.");
    const bytes = Uint8Array.from(atob(payload.pdfBase64), (character) => character.charCodeAt(0));
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    preview.location.replace(objectUrl);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60 * 60 * 1000);
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Le PDF ne peut pas être ouvert.";
    preview.document.title = "PDF indisponible";
    preview.document.body.innerHTML = `<p style="font-family:system-ui;padding:24px">${detail.replace(/[<>&]/g, "")}</p>`;
    return detail;
  }
}

// Ordinateur : fabrique le PDF et renvoie son adresse locale (blob), pour l'afficher DANS la page
// (aucune nouvelle fenêtre). Sur téléphone, on garde openDevisPdf (plein écran dans son onglet).
export async function fetchDevisPdfUrl(url: string, body: Record<string, unknown>): Promise<{ url: string } | { error: string }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PDF-Client-Fetch": "1" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({})) as { pdfBase64?: string; error?: string };
    if (!response.ok || !payload.pdfBase64) return { error: payload.error || "Le PDF ne peut pas être ouvert." };
    const bytes = Uint8Array.from(atob(payload.pdfBase64), (character) => character.charCodeAt(0));
    return { url: URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Le PDF ne peut pas être ouvert." };
  }
}
