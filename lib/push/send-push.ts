import webpush from "web-push";
import { createAdminClient } from "@/lib/supabase/admin";

// Envoie une vraie notification "push" téléphone (avec le son et l'écran de
// verrouillage du système, même application fermée) à un ou plusieurs
// utilisateurs, à partir des abonnements enregistrés dans push_subscriptions
// (voir app/api/push/subscribe/route.ts et components/push-register.tsx pour
// la création de ces abonnements côté client).
//
// N'importer ce fichier QUE depuis du code serveur (routes API) : il utilise
// le client Supabase "admin" (clé service_role) pour lire les abonnements de
// N'IMPORTE QUEL utilisateur, ce qu'un utilisateur normal ne doit jamais
// pouvoir faire lui-même.
let vapidReady = false;
function ensureVapidConfigured() {
  if (vapidReady) return true;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:contact@sebastienbtp.example", publicKey, privateKey);
  vapidReady = true;
  return true;
}

export type PushNotificationContent = { title: string; body: string; url?: string };

// Ne bloque et ne fait jamais échouer l'action d'origine (créer une remarque,
// valider un achat...) si l'envoi push a un problème : chaque échec est
// simplement journalisé (console.error), jamais renvoyé comme une erreur à
// l'appelant.
export async function sendPushToUsers(userIds: string[], notification: PushNotificationContent) {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  if (!uniqueIds.length) return;
  if (!ensureVapidConfigured()) {
    console.warn("[push] VAPID non configurée (NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY manquantes) : notification ignorée.");
    return;
  }
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (error) {
    console.error("[push] client admin indisponible", error);
    return;
  }
  const { data: subscriptions, error } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth_key")
    .in("user_id", uniqueIds);
  if (error) { console.error("[push] lecture des abonnements impossible", error); return; }
  if (!subscriptions?.length) return;
  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    url: notification.url || "/dashboard",
  });
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth_key } },
        payload,
      );
    } catch (sendError) {
      const statusCode = (sendError as { statusCode?: number } | null)?.statusCode;
      // 404/410 = l'abonnement n'existe plus côté navigateur (désinstallation,
      // permission retirée...) : on le retire pour ne plus jamais réessayer.
      if (statusCode === 404 || statusCode === 410) {
        await admin.from("push_subscriptions").delete().eq("id", subscription.id);
      } else {
        console.error("[push] envoi échoué", subscription.id, sendError);
      }
    }
  }));
}
