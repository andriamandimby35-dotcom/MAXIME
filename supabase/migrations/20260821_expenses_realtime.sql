-- La page Dépenses doit se mettre à jour toute seule (nouvel employé, taux
-- MVola, présence, salaire payé, achat/transport/imprévu) sans recharger la
-- page, comme le fait déjà l'Espace chantier.
do $$
begin
  alter publication supabase_realtime add table public.project_staff_members;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.project_daily_attendance;
exception
  when duplicate_object then null;
end $$;
