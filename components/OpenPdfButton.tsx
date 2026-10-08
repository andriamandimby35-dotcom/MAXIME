"use client";

import type { ReactNode } from "react";
import { usePdfViewer } from "@/components/PdfViewerProvider";
import { isPhoneDevice } from "@/lib/is-phone-device";

// Petit bouton réutilisable pour ouvrir un PDF. Ordinateur : le PDF s'affiche dans la carte, sous les boutons
// (avec « Fermer ») via `onOpenInline` fourni par la carte ; téléphone / sans carte : lecteur partagé (comme avant).
export function OpenPdfButton({ title, url, className, children, onOpenInline }: { title: string; url: string; className?: string; children: ReactNode; onOpenInline?: (title: string, url: string) => void }) {
  const { openPdf } = usePdfViewer();
  return (
    <button type="button" className={className} onClick={() => { if (onOpenInline && !isPhoneDevice()) onOpenInline(title, url); else void openPdf(title, url); }}>
      {children}
    </button>
  );
}
