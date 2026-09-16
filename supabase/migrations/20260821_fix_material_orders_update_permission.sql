-- Bug trouvé : project_materials_update et project_material_orders_update
-- utilisaient can_edit_project_record(), une règle pensée pour verrouiller
-- les SAISIES QUOTIDIENNES d'une seule personne (rapports, tâches) — elle
-- exige que ce soit le même jour ET la même personne qui a créé la ligne.
--
-- Mais le stock (project_materials) et les achats (project_material_orders)
-- ne sont pas des saisies figées d'une personne : une demande peut être
-- approuvée un jour et achetée un autre jour, par le conducteur OU le chef,
-- pas forcément celui qui a demandé au départ. Avec l'ancienne règle,
-- l'UPDATE ne levait AUCUNE erreur (RLS filtre juste la ligne en silence),
-- donnant l'impression que "Valider l'achat" avait marché côté écran, alors
-- que le statut, le prix et le stock réel n'étaient jamais enregistrés.
drop policy if exists project_materials_update on public.project_materials;
create policy project_materials_update on public.project_materials for update to authenticated
  using (public.can_manage_project_stock(project_id))
  with check (public.can_manage_project_stock(project_id));

drop policy if exists project_material_orders_update on public.project_material_orders;
create policy project_material_orders_update on public.project_material_orders for update to authenticated
  using (
    public.is_organization_admin(organization_id)
    or public.can_edit_project_record(project_id, organization_id, requested_by, created_at)
    or public.can_manage_project_expenses(project_id)
  )
  with check (public.can_manage_project_expenses(project_id));
