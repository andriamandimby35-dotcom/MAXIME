import { createClient } from "@/lib/supabase/client";

export async function getDaoTemplate(organizationId: string){
  const supabase = createClient();

  const { data, error } = await supabase
    .from("dao_templates")
    .select("id, organization_id, columns")
    .eq("organization_id", organizationId);

  if (error) return null;
  return data;
}
