import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

// Même normalisation que la protection anti-doublon de la base (colonne
// générée "designation_norm" de price_library) : on garde uniquement les
// lettres et les chiffres, en minuscule. Ça permet de reconnaître le même
// matériau même écrit avec des majuscules, des accents ou une ponctuation
// différente (ex: "Fer à béton Ø6" et "FER A BETON D6").
function designationNormKey(value: string) {
  return String(value ?? "").toLowerCase().replace(/[^a-zA-Z0-9]/g, "");
}

// Avant d'enregistrer un nouveau prix, le formulaire appelle cette route pour
// vérifier si un matériau du même nom existe déjà. Si oui, on renvoie toutes
// ses infos pour que l'utilisateur puisse vérifier que c'est bien le même
// matériau avant de valider (voir PriceForm.tsx).
export async function POST(req: Request) {
  try {
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });
    const { data: member } = await supabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

    const body = await req.json();
    const designation = String(body.designation || "").trim();
    const excludeId = body.excludeId ? String(body.excludeId) : null;
    if (!designation) return NextResponse.json({ existing: null });

    const targetKey = designationNormKey(designation);
    const { data, error } = await supabase
      .from("price_library")
      .select("*")
      .eq("organization_id", member.organization_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const existing = (data ?? []).find(
      (price: any) => price.id !== excludeId && designationNormKey(String(price.designation ?? "")) === targetKey,
    ) ?? null;

    return NextResponse.json({ existing });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erreur interne." }, { status: 500 });
  }
}
