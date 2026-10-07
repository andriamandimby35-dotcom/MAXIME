import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireDevisAdmin } from "@/lib/devis/admin";

// Ajouter une ligne à un devis importé (comme « + Ajouter une ligne » du DAO).
// La ligne se place à la fin de sa catégorie, sans décaler les autres. Aucun effet sur la bibliothèque.
type Item = { id: string; category: string | null; ref: string | null; created_at: string | null; is_internal: boolean | null };

// Ajoute n microsecondes à un horodatage Postgres (pour glisser une ligne entre deux lignes existantes, espacées de 1 ms).
function addMicros(timestamp: string, micros: number) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:?\d{2})?$/.exec(timestamp);
  if (!match) return new Date(new Date(timestamp).getTime() + 1).toISOString();
  const [, base, fraction = "", zone = "Z"] = match;
  const total = Number(fraction.padEnd(6, "0")) + micros;
  const seconds = new Date(`${base}${zone === "+00:00" ? "Z" : zone}`).getTime() + Math.floor(total / 1_000_000) * 1000;
  return `${new Date(seconds).toISOString().slice(0, 19)}.${String(total % 1_000_000).padStart(6, "0")}Z`;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;
  const { data: project } = await supabase.from("projects").select("id").eq("id", id).eq("organization_id", auth.organizationId).maybeSingle();
  if (!project) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });

  const body = await request.json().catch(() => ({})) as { category?: string; designation?: string; unit?: string; quantity?: number | string; unit_price?: number | string | null; external_unit_price?: number | string | null; description?: string };
  const designation = String(body.designation ?? "").trim();
  const unit = String(body.unit ?? "").trim();
  const quantity = Number(String(body.quantity ?? "").replace(/\s/g, "").replace(",", "."));
  if (!designation) return NextResponse.json({ error: "Écris la désignation de la ligne." }, { status: 400 });
  if (!unit) return NextResponse.json({ error: "Écris l'unité (m2, ml, Fft…)." }, { status: 400 });
  if (!Number.isFinite(quantity) || quantity <= 0) return NextResponse.json({ error: "La quantité doit être un nombre plus grand que 0." }, { status: 400 });
  const price = (value: unknown) => { const n = Number(String(value ?? "").replace(/\s/g, "").replace(",", ".")); return Number.isFinite(n) && n > 0 ? n : null; };
  const internal = price(body.unit_price);
  const external = price(body.external_unit_price);
  const category = String(body.category ?? "").trim();

  let items: Item[] = [];
  for (const columns of ["id,category,ref,created_at,is_internal", "id,category,created_at,is_internal"]) {
    const result = await supabase.from("project_price_items").select(columns).eq("project_id", id).order("created_at", { ascending: true }).range(0, 4999);
    if (!result.error) { items = (result.data ?? []) as unknown as Item[]; break; }
  }
  const devisItems = items.filter((item) => !item.is_internal);
  const inCategory = devisItems.filter((item) => String(item.category ?? "").trim() === category);
  const anchor = inCategory[inCategory.length - 1] ?? devisItems[devisItems.length - 1] ?? null;
  const createdAt = anchor?.created_at ? addMicros(anchor.created_at, 1) : new Date().toISOString();

  // Numéro de la ligne : suite de celui de la catégorie (« II.11 » → « II.12 »).
  let ref: string | null = null;
  const lastRef = [...inCategory].reverse().map((item) => String(item.ref ?? "").trim()).find(Boolean);
  const refMatch = lastRef ? /^(.*?)(\d+)$/.exec(lastRef) : null;
  if (refMatch) ref = `${refMatch[1]}${Number(refMatch[2]) + 1}`;

  const row = {
    organization_id: auth.organizationId,
    project_id: id,
    position: String(devisItems.length + 1),
    designation,
    unit,
    quantity,
    unit_price: internal,
    external_unit_price: external,
    total: Math.round(quantity * (external ?? internal ?? 0) * 100) / 100 || null,
    is_internal: false,
    created_at: createdAt,
    category: category || null,
    ref,
    description: String(body.description ?? "").trim() || null,
  };
  let { data, error } = await supabase.from("project_price_items").insert(row).select("id").maybeSingle();
  if (error && /\b(ref|description)\b/.test(error.message)) ({ data, error } = await supabase.from("project_price_items").insert({ ...row, ref: undefined, description: undefined }).select("id").maybeSingle());
  if (error && /category/.test(error.message)) ({ data, error } = await supabase.from("project_price_items").insert({ ...row, ref: undefined, description: undefined, category: undefined }).select("id").maybeSingle());
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, id: data?.id ?? null });
}
