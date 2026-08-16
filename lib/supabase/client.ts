import { createBrowserClient } from "@supabase/ssr";

console.log("CLIENT SUPABASE CHARGE");

export function createClient() {

  console.log(
    "SUPABASE URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL
  );

  console.log(
    "SUPABASE KEY EXISTE",
    !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );

  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}