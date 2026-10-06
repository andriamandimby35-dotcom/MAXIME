import { NextResponse } from "next/server";
import { getDeletionContext, previewDeletion } from "@/lib/deletion/chain";
import type { DeletionKind } from "@/lib/deletion/types";

export const dynamic = "force-dynamic";

// Ce qui va disparaître si on supprime un DAO, un devis ou un chantier
// (affiché avant la confirmation). Ne supprime rien.
export async function GET(request: Request) {
  const context = await getDeletionContext();
  if ("response" in context) return context.response;
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") as DeletionKind | null;
  const id = url.searchParams.get("id") ?? "";
  if (!id || (kind !== "tender" && kind !== "estimate" && kind !== "project")) return NextResponse.json({ error: "Demande invalide." }, { status: 400 });
  const preview = await previewDeletion(context.ctx, kind, id);
  if (!preview) return NextResponse.json({ error: "Élément introuvable." }, { status: 404 });
  return NextResponse.json({ preview });
}
