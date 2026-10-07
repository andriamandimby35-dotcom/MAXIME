import type { SupabaseClient } from "@supabase/supabase-js";
import { btpTokens, wordVariants } from "@/lib/prices/synonyms";

// Recherche MANUELLE dans la bibliothèque de prix de l'entreprise (pour choisir soi-même le prix d'une ligne
// que la recherche automatique n'a pas trouvée). Une seule petite requête (300 lignes au plus lues,
// 40 renvoyées) : pas de lecture de toute la bibliothèque. Ne modifie jamais la bibliothèque.
const norm = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const positive = (value: unknown) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; };

export type LibrarySearchResult = { id: string; designation: string; unit: string; category: string; price: number | null };

export async function searchLibrary(supabase: SupabaseClient, organizationId: string, query: string): Promise<LibrarySearchResult[]> {
  const words = norm(query).split(" ").filter((word) => word.length >= 3);
  if (words.length === 0) return [];
  // La recherche connaît le vocabulaire du bâtiment : « agglo » trouve aussi « parpaing », « crépi » trouve « enduit »…
  // La requête SQL cherche le mot le plus long ET ses autres écritures ; le tri se fait ici (mots ramenés au vocabulaire officiel).
  const anchor = [...words].sort((a, b) => b.length - a.length)[0];
  const stems = [...new Set(wordVariants(anchor).map((word) => word.slice(0, Math.max(4, word.length - 1))).concat(anchor.slice(0, Math.max(4, anchor.length - 1))))]
    .filter((stem) => /^[a-z0-9]+$/.test(stem));
  const wanted = btpTokens(query);
  let rows: Array<Record<string, unknown>> = [];
  for (const columns of ["id,designation,unite,categorie,prix_entreprise,prix_retenu,prix_actuel,prix_ia", "*"]) {
    const result = await supabase.from("price_library").select(columns).eq("organization_id", organizationId).or(stems.map((stem) => `designation.ilike.%${stem}%`).join(",")).limit(300);
    if (!result.error) { rows = (result.data ?? []) as unknown as Array<Record<string, unknown>>; break; }
  }
  return rows
    .map((row) => {
      const have = new Set(btpTokens(String(row.designation ?? "")));
      const hits = wanted.filter((word) => have.has(word) || [...have].some((token) => token.length >= 4 && word.length >= 4 && (token.startsWith(word) || word.startsWith(token)))).length;
      const price = positive(row.prix_entreprise) ?? positive(row.prix_retenu) ?? positive(row.prix_actuel) ?? positive(row.prix_ia);
      return { id: String(row.id), designation: String(row.designation ?? ""), unit: String(row.unite ?? ""), category: String(row.categorie ?? ""), price, hits };
    })
    .filter((row) => row.price && row.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.designation.length - b.designation.length)
    .slice(0, 40)
    .map(({ hits: _hits, ...rest }) => rest);
}
