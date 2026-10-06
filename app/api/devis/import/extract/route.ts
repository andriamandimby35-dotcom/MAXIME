import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractDevisFromPdf } from "@/lib/projects/extract-devis-pdf";
import { requireDevisAdmin } from "@/lib/devis/admin";

// Étape 1 de « Ajouter un devis » : l'IA lit le PDF (une seule fois) et renvoie
// les lignes (catégorie, sous-catégorie, désignation, unité, quantité, prix s'il
// y en a un) ainsi que la liste des travaux. Rien n'est enregistré ici.
export const maxDuration = 300;

export async function POST(request: Request) {
  const supabase = await createClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File)) return NextResponse.json({ error: "Fichier PDF manquant." }, { status: 400 });
  if (file.type && file.type !== "application/pdf") return NextResponse.json({ error: "Le fichier doit être un PDF." }, { status: 400 });

  const result = await extractDevisFromPdf(file);
  if (!result.ok) return NextResponse.json(result.body, { status: result.status });
  const data = result.data;
  return NextResponse.json({
    project_name: data.project_name,
    location: data.location,
    works: data.works,
    lines: data.all_lines,
    devis_total: data.devis_total,
    tmp_percent: data.tmp_percent,
    warnings: data.warnings,
  });
}
