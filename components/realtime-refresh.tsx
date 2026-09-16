"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Écoute des changements sur une ou plusieurs tables et redemande les données
// serveur de la page (sans rechargement complet) dès qu'un autre poste ou
// une autre partie de l'appli modifie quelque chose. À placer dans une page
// ou un composant client dont l'affichage dépend de ces tables.
type TableWatch = string | { table: string; filter?: string };

export function RealtimeRefresh({ channelName, tables, filter }: { channelName: string; tables: TableWatch[]; filter?: string }) {
  const router = useRouter();
  const key = tables.map((entry) => typeof entry === "string" ? `${entry}:${filter ?? ""}` : `${entry.table}:${entry.filter ?? ""}`).join(",");

  useEffect(() => {
    const supabase = createClient();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => router.refresh(), 400);
    };
    let channel = supabase.channel(channelName);
    for (const entry of tables) {
      const table = typeof entry === "string" ? entry : entry.table;
      const entryFilter = typeof entry === "string" ? filter : (entry.filter ?? filter);
      channel = channel.on(
        "postgres_changes",
        entryFilter ? { event: "*", schema: "public", table, filter: entryFilter } : { event: "*", schema: "public", table },
        scheduleRefresh,
      );
    }
    channel.subscribe();
    return () => {
      if (timeout) clearTimeout(timeout);
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelName, key]);

  return null;
}
