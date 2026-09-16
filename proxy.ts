import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Un conducteur ou un chef de chantier ne doit voir que l'espace de son ou
// ses chantiers — jamais le tableau de bord, les devis, les prix, etc.
// L'administrateur (ou propriétaire) n'est jamais restreint ici.
export async function proxy(request: NextRequest) {
  const url = request.nextUrl.pathname;

  // Laisser les pages publiques accessibles
  if (
    url.startsWith("/login") ||
    url.startsWith("/api") ||
    url.startsWith("/auth") ||
    url.startsWith("/_next")
  ) {
    return NextResponse.next();
  }

  const response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return response;

  const { data: member } = await supabase
    .from("organization_members")
    .select("role, active")
    .eq("user_id", user.id)
    .maybeSingle();
  const isAdmin = Boolean(member?.active && ["owner", "admin"].includes(member.role));
  if (isAdmin) return response;

  const { data: assignments } = await supabase
    .from("project_assignments")
    .select("project_id")
    .eq("user_id", user.id)
    .eq("active", true);
  const projectIds = [...new Set((assignments ?? []).map((row) => row.project_id))];
  const fallback = projectIds.length === 1 ? `/projects/${projectIds[0]}` : "/projects";

  if (url === "/projects") return response;

  const projectMatch = url.match(/^\/projects\/([^/]+)/);
  if (projectMatch) {
    if (projectIds.includes(projectMatch[1])) return response;
    return NextResponse.redirect(new URL(fallback, request.url));
  }

  return NextResponse.redirect(new URL(fallback, request.url));
}


export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
