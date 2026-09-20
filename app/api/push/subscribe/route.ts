import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

// Enregistre (ou met à jour) l'abonnement "push" du navigateur/téléphone
// courant pour l'utilisateur connecté — voir components/push-register.tsx,
// qui appelle cette route juste après avoir créé l'abonnement navigateur.
// Un même utilisateur peut avoir plusieurs abonnements actifs (téléphone,
// ordinateur...) : chacun reçoit ses propres notifications.
export async function POST(request: Request) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const body = await request.json().catch(() => null) as { endpoint?: string; p256dh?: string; auth?: string; userAgent?: string } | null;
  const endpoint = body?.endpoint?.trim();
  const p256dh = body?.p256dh?.trim();
  const authKey = body?.auth?.trim();
  if (!endpoint || !p256dh || !authKey) return NextResponse.json({ error: "Abonnement incomplet." }, { status: 400 });

  const { error } = await supabase.from("push_subscriptions").upsert({
    user_id: user.id,
    endpoint,
    p256dh,
    auth_key: authKey,
    user_agent: body?.userAgent?.slice(0, 300) || null,
  }, { onConflict: "endpoint" });
  if (error) return NextResponse.json({ error: `Abonnement non enregistré : ${error.message}` }, { status: 500 });

  return NextResponse.json({ ok: true });
}

// Retire l'abonnement courant (ex. l'utilisateur désactive les notifications
// dans les réglages de son téléphone/navigateur).
export async function DELETE(request: Request) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const body = await request.json().catch(() => null) as { endpoint?: string } | null;
  const endpoint = body?.endpoint?.trim();
  if (!endpoint) return NextResponse.json({ error: "Abonnement manquant." }, { status: 400 });

  await supabase.from("push_subscriptions").delete().eq("user_id", user.id).eq("endpoint", endpoint);
  return NextResponse.json({ ok: true });
}
