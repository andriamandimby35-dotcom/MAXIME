import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { extractDevisFromPdf } from "@/lib/projects/extract-devis-pdf";

// Étape "automatique" de la création d'un chantier : on donne directement un
// PDF de devis (pas forcément un devis déjà enregistré dans Sébastien), et on
// en extrait la liste des travaux à réaliser (planning du chantier) ET, quand
// le devis en contient, les prix par catégorie / ligne (utilisés ensuite pour
// le montant certifié et la facturation client). Le PDF lui-même n'est pas
// enregistré : cette route ne fait qu'analyser, la création du chantier se
// fait ensuite via /api/projects (mode "manual"), avec la liste et les prix
// vérifiés/corrigés par l'utilisateur.
export async function POST(request: Request) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: member } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File)) return NextResponse.json({ error: "Fichier PDF manquant." }, { status: 400 });
  if (file.type && file.type !== "application/pdf") {
    return NextResponse.json({ error: "Le fichier doit être un PDF." }, { status: 400 });
  }

  const result = await extractDevisFromPdf(file);
  if (!result.ok) return NextResponse.json(result.body, { status: result.status });
  return NextResponse.json(result.data);
}
