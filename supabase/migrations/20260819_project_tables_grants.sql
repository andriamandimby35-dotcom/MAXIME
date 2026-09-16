-- Même défaut que estimates/price_library/price_history plus tôt : toutes les
-- tables du suivi de chantier (rapports du chef de chantier, stock, dépenses,
-- présence, photos) ont été créées sans GRANT pour service_role (et parfois
-- authenticated), ce qui bloque silencieusement certaines relations entre
-- chef de chantier -> stock -> dépenses -> tableau de bord.
grant select, insert, update, delete on public.projects to authenticated, service_role;
grant select, insert, update, delete on public.project_tasks to authenticated, service_role;
grant select, insert, update, delete on public.project_daily_reports to authenticated, service_role;
grant select, insert, update, delete on public.project_materials to authenticated, service_role;
grant select, insert, update, delete on public.project_stock_movements to authenticated, service_role;
grant select, insert, update, delete on public.project_material_orders to authenticated, service_role;
grant select, insert, update, delete on public.project_photos to authenticated, service_role;
grant select, insert, update, delete on public.project_ai_suggestions to authenticated, service_role;
grant select, insert, update, delete on public.project_record_notes to authenticated, service_role;
grant select, insert, update, delete on public.project_staff_members to authenticated, service_role;
grant select, insert, update, delete on public.project_daily_attendance to authenticated, service_role;
grant select, insert, update, delete on public.project_report_material_usages to authenticated, service_role;
