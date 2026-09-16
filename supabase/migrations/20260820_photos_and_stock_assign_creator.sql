-- project_photos et project_stock_movements exigent created_by = auth.uid()
-- dans leur policy RLS d'insertion, mais n'avaient pas le déclencheur qui le
-- remplit automatiquement (contrairement à project_materials, project_tasks,
-- project_daily_reports, project_ai_suggestions, project_record_notes qui
-- l'ont déjà). Conséquence : toute photo ou tout mouvement de stock inséré
-- sans created_by explicite était rejeté par la RLS, souvent silencieusement.
drop trigger if exists project_photos_assign_creator on public.project_photos;
create trigger project_photos_assign_creator before insert on public.project_photos
  for each row execute function public.project_record_before_insert();

drop trigger if exists project_stock_movements_assign_creator on public.project_stock_movements;
create trigger project_stock_movements_assign_creator before insert on public.project_stock_movements
  for each row execute function public.project_record_before_insert();
