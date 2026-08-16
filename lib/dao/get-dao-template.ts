import { createClient } from "@/lib/supabase/client";

export async function getDaoTemplate(){
  const supabase = createClient();

  const { data, error } = await supabase
    .from("dao_templates")
    .select("id, organization_id, columns");

  if (error) return null;
  return data;
}
