"use client";

import type { ReactNode } from "react";
import { usePdfViewer } from "@/components/PdfViewerProvider";

// Petit bouton réutilisable pour ouvrir un PDF dans la carte partagée
// (PdfViewerProvider) au lieu d'un nouvel onglet — utilisable depuis une page
// serveur (qui ne peut pas appeler usePdfViewer elle-même).
export function OpenPdfButton({ title, url, className, children }: { title: string; url: string; className?: string; children: ReactNode }) {
  const { openPdf } = usePdfViewer();
  return (
    <button type="button" className={className} onClick={() => void openPdf(title, url)}>
      {children}
    </button>
  );
}
