import { createServerClient } from "@/lib/supabase/server";

export async function getContext() {
  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Aucun utilisateur connecté
  if (!user) {
    return {
      supabase,
      user: null,
      organization: null,
      organizationId: null,
      memberRole: null,
    };
  }

  // Les collaborateurs invités rejoignent leur chantier dès leur première
  // connexion avec l'adresse e-mail invitée.
  await supabase.rpc("accept_my_project_access_invitations");

  // Recherche de l'entreprise liée à l'utilisateur
  const {
    data: member,
    error,
  } = await supabase
    .from("organization_members")
    .select(`
      organization_id,
      role,
      active,
      organizations (
        id,
        name,
        phone,
        created_at
      )
    `)
    .eq("user_id", user.id)
    .single();

  console.log("UTILISATEUR :", user.id);
  console.log("MEMBRE :", member);
  console.log("ERREUR MEMBRE :", error);

  if (!member) {
    return {
      supabase,
      user,
      organization: null,
      organizationId: null,
      memberRole: null,
    };
  }

  console.log("ENTREPRISE :", member.organizations);

  return {
  supabase,
  user,
  organization: member.organizations?.[0] ?? null,
  organizationId: member.organization_id,
  memberRole: member.role ?? "admin",
};
}
