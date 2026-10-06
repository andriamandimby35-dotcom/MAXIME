import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadExpenseAllocation } from "@/lib/expenses/allocation";

// Détail des dépenses d'un chantier classées par catégorie / sous-catégorie du
// devis (voir lib/expenses/allocation.ts). Lecture seule : tout est recalculé à
// la demande à partir des achats, rapports, présences et paiements existants.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });
  // Le chantier doit être visible pour cet utilisateur (règles d'accès de la base).
  const { data: project } = await supabase.from("projects").select("id").eq("id", id).maybeSingle();
  if (!project) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });
  const allocation = await loadExpenseAllocation(supabase, id);
  return NextResponse.json(allocation, { headers: { "Cache-Control": "private, no-store" } });
}
