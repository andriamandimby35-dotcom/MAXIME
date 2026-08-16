import { NextResponse } from "next/server";
import { createAIPrice } from "@/lib/price-engine/create-ai-price";
import { createServerClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Non autorisé." }, { status: 401 });
  }

  const { data: member } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (!member?.organization_id) {
    return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });
  }

  const body = await req.json();

  const result = await createAIPrice({
    designation: body.designation,
    categorie: body.categorie,
    unite: body.unite,
    region: body.region,
    organizationId: member.organization_id,
  });

  return NextResponse.json({
    success: true,
    result,
  });
}
