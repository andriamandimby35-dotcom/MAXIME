import type { SupabaseClient } from "@supabase/supabase-js";
import { companyProfile } from "@/lib/company";

// Informations d'entreprise utilisées pour pré-remplir les PDF (devis,
// factures, dossiers de soumission). Elles viennent de l'écran "Profil
// entreprise" (table organization_submission_profiles, déjà utilisée par les
// dossiers de soumission DAO) ; tant qu'un champ n'a pas été rempli sur cet
// écran, on retombe sur les valeurs figées de lib/company.ts pour ne jamais
// afficher un document incomplet.
export async function getCompanyProfileForPdf(
  supabase: SupabaseClient,
  organizationId: string,
  organizationName?: string | null,
) {
  const { data } = await supabase
    .from("organization_submission_profiles")
    .select("profile_data")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const profile = (data?.profile_data ?? {}) as Record<string, string>;

  return {
    companyName: profile.trade_name || profile.legal_name || organizationName || companyProfile.tradeName,
    ownerName: profile.representative_name || companyProfile.ownerName,
    address: profile.address || companyProfile.address,
    phone: profile.phone || companyProfile.phone,
    nif: profile.nif || companyProfile.nif,
    stat: profile.stat || companyProfile.stat,
    rcs: profile.rcs || companyProfile.rcs,
  };
}
