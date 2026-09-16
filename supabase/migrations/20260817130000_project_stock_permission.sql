-- Autorisation explicite de stock : le conducteur (et le chef si cette
-- autorisation lui est accordée) peut enregistrer uniquement ses propres
-- matériaux et mouvements du jour, pour le chantier auquel il est affecté.

-- Les accès existants créés avant le sélecteur d'autorisations conservent le
-- comportement historique : stock autorisé. Un refus explicite reste respecté.
update public.project_assignments
set permissions = jsonb_set(coalesce(permissions, '{}'::jsonb), '{stock}', 'true'::jsonb, true)
where active
  and role in ('works_manager', 'site_manager')
  and not (coalesce(permissions, '{}'::jsonb) ? 'stock');

update public.project_access_invitations
set permissions = jsonb_set(coalesce(permissions, '{}'::jsonb), '{stock}', 'true'::jsonb, true)
where status = 'pending'
  and role in ('works_manager', 'site_manager')
  and not (coalesce(permissions, '{}'::jsonb) ? 'stock');

create or replace function public.can_manage_project_stock(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.projects p
    where p.id = target_project_id
      and (
        public.is_organization_admin(p.organization_id)
        or exists (
          select 1
          from public.project_assignments a
          where a.project_id = target_project_id
            and a.user_id = auth.uid()
            and a.active
            and a.role in ('works_manager', 'site_manager')
            and coalesce(a.permissions, '{}'::jsonb) @> '{"stock": true}'::jsonb
        )
      )
  );
$$;

revoke all on function public.can_manage_project_stock(uuid) from public;
grant execute on function public.can_manage_project_stock(uuid) to authenticated;

drop policy if exists project_materials_insert on public.project_materials;
drop policy if exists project_materials_update on public.project_materials;
drop policy if exists project_materials_delete on public.project_materials;
create policy project_materials_insert on public.project_materials for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.can_manage_project_stock(project_id)
  );
create policy project_materials_update on public.project_materials for update to authenticated
  using (
    public.can_manage_project_stock(project_id)
    and public.can_edit_project_record(project_id, organization_id, created_by, created_at)
  )
  with check (
    public.can_manage_project_stock(project_id)
    and public.can_edit_project_record(project_id, organization_id, created_by, created_at)
  );
create policy project_materials_delete on public.project_materials for delete to authenticated
  using (
    public.can_manage_project_stock(project_id)
    and public.can_edit_project_record(project_id, organization_id, created_by, created_at)
  );

drop policy if exists project_stock_insert on public.project_stock_movements;
drop policy if exists project_stock_update on public.project_stock_movements;
drop policy if exists project_stock_delete on public.project_stock_movements;
create policy project_stock_insert on public.project_stock_movements for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.can_manage_project_stock(project_id)
  );
create policy project_stock_update on public.project_stock_movements for update to authenticated
  using (
    public.can_manage_project_stock(project_id)
    and public.can_edit_project_record(project_id, organization_id, created_by, created_at)
  )
  with check (
    public.can_manage_project_stock(project_id)
    and public.can_edit_project_record(project_id, organization_id, created_by, created_at)
  );
create policy project_stock_delete on public.project_stock_movements for delete to authenticated
  using (
    public.can_manage_project_stock(project_id)
    and public.can_edit_project_record(project_id, organization_id, created_by, created_at)
  );
