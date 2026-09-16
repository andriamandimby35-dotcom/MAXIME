-- Le magasin (stock actuel + historique des mouvements) doit se mettre à
-- jour en direct chez tout le monde quand un achat est validé ou une
-- consommation déclarée, sans attendre un rechargement de page.
do $$
begin
  alter publication supabase_realtime add table public.project_stock_movements;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.project_materials;
exception
  when duplicate_object then null;
end $$;
