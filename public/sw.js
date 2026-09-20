const CACHE = "sebastien-btp-v3";
const OFFLINE = "/offline.html";
const STATIC_ASSETS = [OFFLINE, "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

// Reçoit une vraie notification "push" envoyée par le serveur (voir
// lib/push/send-push.ts), même application fermée. Le titre et le texte
// viennent du serveur (jamais inventés ici) ; url indique la page à ouvrir
// au clic (voir notificationclick ci-dessous).
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || "Sébastien BTP";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    // vibrate : même motif que l'alerte sonore déjà utilisée dans l'appli
    // pour une remarque urgente, désormais aussi ressenti hors application.
    vibrate: [140, 70, 140],
    data: { url: data.url || "/dashboard" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Un clic sur la notification ouvre directement la bonne page dans
// l'application — si un onglet de l'appli est déjà ouvert, on le réutilise
// et on le fait juste naviguer, plutôt que d'en ouvrir un second.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/dashboard";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        if ("focus" in client) {
          if ("navigate" in client) client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // Les PDF et données privées sont toujours lus directement depuis l'API.
  // Ils ne doivent jamais traverser le cache PWA.
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && ["document", "style", "script", "image"].includes(event.request.destination)) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === "navigate") return caches.match(OFFLINE);
        return new Response("Hors connexion", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      })
  );
});
