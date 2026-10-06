"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// Curseur « travail » sur toute l'application : dès qu'une requête est en cours
// (chargement d'une page, génération d'une facture, analyse d'un PDF par l'IA,
// enregistrement…), le curseur de la souris devient un curseur de travail
// (flèche + petit cercle qui tourne) ; il redevient normal dès que tout est
// terminé. Un seul composant, placé une fois dans le layout : il observe toutes
// les requêtes réseau de l'appli, donc aucune page n'a rien à ajouter.

const SHOW_AFTER_MS = 150; // évite le clignotement pour les requêtes très rapides
const FAILSAFE_MS = 5 * 60 * 1000; // une requête bloquée ne garde jamais le curseur plus de 5 min
const NAVIGATION_FAILSAFE_MS = 15 * 1000;

declare global {
  interface Window { __busyCursorInstalled?: boolean }
}

export function BusyCursor() {
  const pathname = usePathname();

  useEffect(() => {
    if (window.__busyCursorInstalled) return;
    window.__busyCursorInstalled = true;

    const root = document.documentElement;
    let pending = 0;
    let navigating = false;
    let showTimer: ReturnType<typeof setTimeout> | null = null;

    const update = () => {
      const busy = pending > 0 || navigating;
      if (!busy) {
        if (showTimer) { clearTimeout(showTimer); showTimer = null; }
        delete root.dataset.busy;
        return;
      }
      if (root.dataset.busy === "1" || showTimer) return;
      showTimer = setTimeout(() => {
        showTimer = null;
        if (pending > 0 || navigating) root.dataset.busy = "1";
      }, SHOW_AFTER_MS);
    };

    // 1. Toutes les requêtes réseau (API, pages, Supabase, actions serveur).
    const originalFetch = window.fetch.bind(window);
    window.fetch = (...args: Parameters<typeof fetch>) => {
      pending += 1;
      update();
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        pending = Math.max(0, pending - 1);
        update();
      };
      const failsafe = setTimeout(finish, FAILSAFE_MS);
      return originalFetch(...args).finally(() => { clearTimeout(failsafe); finish(); });
    };

    // 2. Clic sur un lien interne : le curseur travaille jusqu'au changement de page.
    let navigationTimer: ReturnType<typeof setTimeout> | null = null;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      navigating = true;
      update();
      if (navigationTimer) clearTimeout(navigationTimer);
      navigationTimer = setTimeout(() => { navigating = false; update(); }, NAVIGATION_FAILSAFE_MS);
    };
    document.addEventListener("click", onClick, true);
    (window as unknown as { __busyCursorStopNavigation?: () => void }).__busyCursorStopNavigation = () => {
      navigating = false;
      if (navigationTimer) { clearTimeout(navigationTimer); navigationTimer = null; }
      update();
    };
    // Ce composant vit toute la durée de l'appli (layout racine) : on ne
    // retire donc pas ces écouteurs.
  }, []);

  // 3. La page a changé : la navigation est terminée.
  useEffect(() => {
    (window as unknown as { __busyCursorStopNavigation?: () => void }).__busyCursorStopNavigation?.();
  }, [pathname]);

  return null;
}
