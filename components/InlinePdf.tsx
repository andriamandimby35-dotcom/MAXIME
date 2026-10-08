"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { toFriendlyPdfError } from "@/lib/submission/friendly-pdf-error";

// Affichage d'un PDF DANS la carte / la page, juste sous les boutons (aucune nouvelle fenêtre,
// aucune fenêtre par-dessus la page), avec un bouton « Fermer ». Même principe que les devis.
// Utilisé sur ordinateur ; le téléphone garde son comportement d'avant (voir chaque page).
type Options = { method?: "GET" | "POST"; cache?: RequestCache };
type Shown = { title: string; url: string; revoke: boolean };

export function useInlinePdf(): {
  open: (title: string, documentUrl: string, options?: Options) => Promise<void>;
  show: (title: string, objectUrl: string, revokeOnClose?: boolean) => void;
  close: () => void;
  busy: boolean;
  isOpen: boolean;
  /** À placer dans la carte, sous les boutons. */
  frame: ReactNode;
} {
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const holder = useRef<HTMLDivElement | null>(null);
  const shownRef = useRef<Shown | null>(null);
  shownRef.current = shown;

  useEffect(() => () => { if (shownRef.current?.revoke) URL.revokeObjectURL(shownRef.current.url); }, []);
  useEffect(() => {
    if (!busy) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = "wait";
    return () => { document.body.style.cursor = previous; };
  }, [busy]);
  useEffect(() => {
    if (shown) window.setTimeout(() => holder.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
  }, [shown]);

  function close() {
    setShown((current) => {
      if (current?.revoke) URL.revokeObjectURL(current.url);
      return null;
    });
    setError("");
  }

  function show(title: string, objectUrl: string, revokeOnClose = false) {
    setError("");
    setShown((current) => {
      if (current?.revoke) URL.revokeObjectURL(current.url);
      return { title, url: objectUrl, revoke: revokeOnClose };
    });
  }

  async function open(title: string, documentUrl: string, options?: Options) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const isLocal = (() => {
        try { return new URL(documentUrl, window.location.href).origin === window.location.origin; }
        catch { return false; }
      })();
      if (!isLocal) { show(title, documentUrl, false); return; }
      const { data: { session } } = await createClient().auth.getSession();
      const response = await fetch(documentUrl, {
        method: options?.method || "GET",
        credentials: "same-origin",
        cache: options?.cache ?? "no-store",
        headers: session?.access_token ? {
          Authorization: `Bearer ${session.access_token}`,
          "X-Supabase-Access-Token": session.access_token,
          "X-PDF-Client-Fetch": "1",
        } : undefined,
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const signature = new TextDecoder().decode(bytes.slice(0, 5));
      if (!response.ok || !signature.startsWith("%PDF-")) {
        const detail = new TextDecoder().decode(bytes.slice(0, 400)).replace(/\s+/g, " ").trim();
        throw new Error(detail || `Le serveur a répondu avec le statut ${response.status}.`);
      }
      show(title, URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })), true);
    } catch (caught) {
      const raw = caught instanceof Error ? caught.message : "Le PDF n’a pas pu être préparé.";
      setError(toFriendlyPdfError(raw));
    } finally {
      setBusy(false);
    }
  }

  const frame = (shown || error || busy) ? (
    <div ref={holder} style={{ flexBasis: "100%", width: "100%", minWidth: 0, marginTop: 8 }} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      {busy && !shown && <p style={{ margin: 0, fontSize: ".85rem" }}>Préparation du PDF…</p>}
      {error && <p className="notice" style={{ overflowWrap: "anywhere" }}>{error}</p>}
      {shown && (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 6, minWidth: 0 }}>
            <strong style={{ fontSize: ".9rem", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shown.title}</strong>
            <button type="button" className="ghostButton" onClick={close}>Fermer</button>
          </div>
          <iframe src={shown.url} title={shown.title} style={{ width: "100%", height: "70vh", minHeight: 420, border: "1px solid #b8d7c0", borderRadius: 8, background: "#fff" }} />
        </>
      )}
    </div>
  ) : null;

  return { open, show, close, busy, isOpen: Boolean(shown), frame };
}
