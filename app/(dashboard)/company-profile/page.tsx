import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CompanyProfileForm } from "@/components/organization/CompanyProfileForm";

export default async function CompanyProfilePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) notFound();

  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!member?.organization_id) notFound();

  const { data } = await supabase
    .from("organization_submission_profiles")
    .select("profile_data")
    .eq("organization_id", member.organization_id)
    .maybeSingle();

  return (
    <section>
      <div className="pageHead">
        <div><h1>Profil entreprise</h1><p>Les informations de ton entreprise, utilisées pour remplir automatiquement tes documents.</p></div>
      </div>
      <CompanyProfileForm initialProfile={(data?.profile_data as Record<string, string>) ?? {}} />
    </section>
  );
}
