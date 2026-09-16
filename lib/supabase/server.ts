import { createServerClient as createSupabaseServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";

export async function createServerClient() {

  const cookieStore = await cookies();
  const requestHeaders = await headers();
  const authorization = requestHeaders.get("authorization")
    || (requestHeaders.get("x-supabase-access-token") ? `Bearer ${requestHeaders.get("x-supabase-access-token")}` : "");

  return createSupabaseServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },

        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Appel depuis un Server Component : l'écriture des cookies
            // est alors prise en charge par le proxy/middleware.
          }
        },
      },
      // Le lecteur PDF peut transmettre le jeton de la session navigateur.
      // Cela complète les cookies pour les ouvertures dans un nouvel onglet.
      global: authorization.startsWith("Bearer ") ? { headers: { Authorization: authorization } } : undefined,
    }
  );

}

// Nom conservé pour les anciens fichiers du projet.
// Il utilise exactement le même client Supabase côté serveur.
export const createClient = createServerClient;
