import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Un salaire journalier ou un prix de transport saisi dans un devis est gardé dans la bibliothèque de l'entreprise
// (même nom + même unité = remplacé, sinon créé) : les prochains devis le retrouvent seuls.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Session expirée." }, { status: 401 });
  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { designation?: string; unit?: string; price?: number };
  const designation = String(body.designation ?? "").trim();
  const unit = String(body.unit ?? "").trim();
  const price = Number(body.price);
  if (!designation || !unit || !(price > 0)) return NextResponse.json({ error: "Désignation, unité et prix sont obligatoires." }, { status: 400 });

  const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const { data: rows } = await supabase.from("price_library").select("id,designation,unite").eq("organization_id", member.organization_id).ilike("designation", `%${designation.slice(0, 20).replace(/[%_]/g, "")}%`).limit(50);
  const found = (rows ?? []).find((row) => key(String(row.designation ?? "")) === key(designation));
  if (found?.id) {
    const { error } = await supabase.from("price_library").update({ prix_entreprise: price, prix_retenu: price, updated_at: new Date().toISOString() }).eq("id", String(found.id));
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true, updated: true });
  }
  const { error } = await supabase.from("price_library").insert({
    organization_id: member.organization_id, designation, categorie: "COÛTS INTERNES DU CHANTIER", unite: unit,
    prix_entreprise: price, prix_retenu: price, prix_source: "saisie_locale", statut_validation: "valide_manuellement", statut_prix: "manuel", origine_prix: "saisie_locale",
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, created: true });
}
