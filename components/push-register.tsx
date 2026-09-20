"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

// La clé VAPID publique est une chaîne "base64url" : le navigateur attend un
// tableau d'octets (Uint8Array) pour s'abonner, jamais la chaîne telle quelle.
function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// Abonne cet appareil aux notifications push dès qu'un compte est connecté
// (admin, conducteur, chef ou consultation — tous les postes) et que le
// service worker est prêt (voir components/pwa-register.tsx). Ne redemande
// jamais la permission si elle a déjà été refusée : dans ce cas, l'utilisateur
// doit la réactiver lui-même dans les réglages de son navigateur/téléphone.
// Sur iPhone, les notifications push ne fonctionnent QUE si l'application a
// d'abord été installée sur l'écran d'accueil (Safari : partager → « Sur
// l'écran d'accueil ») — c'est une limitation d'Apple, pas de l'application.
export function PushRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
    const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!publicKey) return;
    let cancelled = false;
    (async () => {
      try {
        const registration = await navigator.serviceWorker.ready;
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
          if (Notification.permission === "default") await Notification.requestPermission();
          if (Notification.permission !== "granted") return;
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          });
        }
        if (cancelled || !subscription) return;
        const raw = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
        if (!raw.endpoint || !raw.keys?.p256dh || !raw.keys?.auth) return;
        const supabase = createClient();
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;
        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
            "X-Supabase-Access-Token": session.access_token,
          },
          body: JSON.stringify({ endpoint: raw.endpoint, p256dh: raw.keys.p256dh, auth: raw.keys.auth, userAgent: navigator.userAgent }),
        });
      } catch (error) {
        console.error("[push] abonnement impossible", error);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return null;
}
