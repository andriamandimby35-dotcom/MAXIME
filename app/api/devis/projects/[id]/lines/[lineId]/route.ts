import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireDevisAdmin } from "@/lib/devis/admin";

// Modifier ou supprimer UNE ligne d'un devis importé (comme « Modifier » et « Supprimer » du DAO).
// Aucun effet sur la bibliothèque de prix.
async function lineOf(supabase: Awaited<ReturnType<typeof createClient>>, organizationId: string, projectId: string, lineId: string) {
  const { data: project } = await supabase.from("projects").select("id").eq("id", projectId).eq("organization_id", organizationId).maybeSingle();
  if (!project) return null;
  const { data } = await supabase.from("project_price_items").select("id,quantity,unit_price,external_unit_price").eq("id", lineId).eq("project_id", projectId).maybeSingle();
  return data as { id: string; quantity: number | null; unit_price: number | null; external_unit_price: number | null } | null;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; lineId: string }> }) {
  const { id, lineId } = await params;
  const supabase = await createClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;
  const line = await lineOf(supabase, auth.organizationId, id, lineId);
  if (!line) return NextResponse.json({ error: "Ligne introuvable." }, { status: 404 });

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const toNumber = (value: unknown) => Number(String(value ?? "").replace(/\s/g, "").replace(",", "."));
  const update: Record<string, unknown> = {};
  if ("designation" in body) {
    const designation = String(body.designation ?? "").trim();
    if (!designation) return NextResponse.json({ error: "La désignation ne peut pas être vide." }, { status: 400 });
    update.designation = designation;
  }
  if ("unit" in body) update.unit = String(body.unit ?? "").trim() || null;
  if ("quantity" in body) {
    const quantity = toNumber(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return NextResponse.json({ error: "La quantité doit être un nombre plus grand que 0." }, { status: 400 });
    update.quantity = quantity;
  }
  // Prix vide ou 0 = prix effacé (la ligne redevient « à remplir »).
  for (const key of ["unit_price", "external_unit_price"] as const) {
    if (!(key in body)) continue;
    const raw = String(body[key] ?? "").trim();
    if (raw === "") { update[key] = null; continue; }
    const value = toNumber(raw);
    if (!Number.isFinite(value) || value < 0) return NextResponse.json({ error: "Un prix doit être un nombre." }, { status: 400 });
    update[key] = value > 0 ? value : null;
  }
  const quantity = Number(update.quantity ?? line.quantity) || 1;
  const external = "external_unit_price" in update ? update.external_unit_price : line.external_unit_price;
  const internal = "unit_price" in update ? update.unit_price : line.unit_price;
  update.total = Math.round(quantity * (Number(external) || Number(internal) || 0) * 100) / 100 || null;
  // Texte complet du devis (PDF) : seulement si la colonne existe (SQL 20261013).
  const textUpdate: Record<string, unknown> = {};
  if ("description" in body) textUpdate.description = String(body.description ?? "").trim() || null;
  if ("concerne" in body) textUpdate.concerne = String(body.concerne ?? "").trim() || null;

  let { error } = await supabase.from("project_price_items").update({ ...update, ...textUpdate }).eq("id", lineId).eq("project_id", id);
  if (error && /description|concerne/.test(error.message)) ({ error } = await supabase.from("project_price_items").update(update).eq("id", lineId).eq("project_id", id));
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; lineId: string }> }) {
  const { id, lineId } = await params;
  const supabase = await createClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;
  const line = await lineOf(supabase, auth.organizationId, id, lineId);
  if (!line) return NextResponse.json({ error: "Ligne introuvable." }, { status: 404 });
  const { error } = await supabase.from("project_price_items").delete().eq("id", lineId).eq("project_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
