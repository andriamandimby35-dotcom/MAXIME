-- Les rapports journaliers (et leurs photos, consommations de matériaux)
-- doivent apparaître en direct chez tout le monde, sans rechargement de page,
-- comme le stock et les demandes de matériaux.
do $$
begin
  alter publication supabase_realtime add table public.project_daily_reports;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.project_photos;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.project_report_material_usages;
exception
  when duplicate_object then null;
end $$;
