create or replace function public.reject_locked_project_record()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.created_at::date < current_date and not public.is_organization_admin(old.organization_id) then
    raise exception 'Cette saisie est verrouillée car elle a été synchronisée un jour précédent.'
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop policy if exists project_tasks_read on public.project_tasks;
create policy project_tasks_read on public.project_tasks for select to authenticated
  using (public.can_access_project(project_id));

drop policy if exists project_tasks_delete on public.project_tasks;
create policy project_tasks_delete on public.project_tasks for delete to authenticated
  using (public.is_organization_admin(organization_id));

drop policy if exists project_reports_delete on public.project_daily_reports;
create policy project_reports_delete on public.project_daily_reports for delete to authenticated
  using (public.is_organization_admin(organization_id));

drop policy if exists project_materials_delete on public.project_materials;
create policy project_materials_delete on public.project_materials for delete to authenticated
  using (public.is_organization_admin(organization_id));

drop policy if exists project_stock_delete on public.project_stock_movements;
create policy project_stock_delete on public.project_stock_movements for delete to authenticated
  using (public.is_organization_admin(organization_id));

drop policy if exists project_material_orders_delete on public.project_material_orders;
create policy project_material_orders_delete on public.project_material_orders for delete to authenticated
  using (public.is_organization_admin(organization_id));

drop policy if exists project_daily_attendance_delete on public.project_daily_attendance;
create policy project_daily_attendance_delete on public.project_daily_attendance for delete to authenticated
  using (public.is_organization_admin(organization_id));

drop policy if exists project_photos_access on public.project_photos;
drop policy if exists project_photos_select on public.project_photos;
create policy project_photos_select on public.project_photos for select to authenticated
  using (public.can_access_project(project_id));
drop policy if exists project_photos_insert on public.project_photos;
create policy project_photos_insert on public.project_photos for insert to authenticated
  with check (public.can_access_project(project_id));
drop policy if exists project_photos_update on public.project_photos;
create policy project_photos_update on public.project_photos for update to authenticated
  using (public.can_access_project(project_id)) with check (public.can_access_project(project_id));
drop policy if exists project_photos_delete on public.project_photos;
create policy project_photos_delete on public.project_photos for delete to authenticated
  using (public.is_organization_admin(organization_id));

drop policy if exists project_staff_members_manage on public.project_staff_members;
drop policy if exists project_staff_members_manage_attendance on public.project_staff_members;
drop policy if exists project_staff_members_select on public.project_staff_members;
create policy project_staff_members_select on public.project_staff_members for select to authenticated
  using (public.can_access_project(project_id));
drop policy if exists project_staff_members_insert on public.project_staff_members;
create policy project_staff_members_insert on public.project_staff_members for insert to authenticated
  with check (public.can_manage_project_attendance(project_id));
drop policy if exists project_staff_members_update on public.project_staff_members;
create policy project_staff_members_update on public.project_staff_members for update to authenticated
  using (public.can_manage_project_attendance(project_id)) with check (public.can_manage_project_attendance(project_id));
drop policy if exists project_staff_members_delete on public.project_staff_members;
create policy project_staff_members_delete on public.project_staff_members for delete to authenticated
  using (public.is_organization_admin(organization_id));

alter table public.project_stock_movements add column if not exists report_id uuid references public.project_daily_reports(id) on delete set null;
alter table public.project_stock_movements add column if not exists source_order_id uuid references public.project_material_orders(id) on delete set null;
create index if not exists project_stock_movements_report_idx on public.project_stock_movements(report_id);
create index if not exists project_stock_movements_source_order_idx on public.project_stock_movements(source_order_id);

create or replace function public.record_project_daily_report_consumption(
  p_project_id uuid,
  p_report_date date,
  p_weather text default null,
  p_workers_present integer default 0,
  p_completed_work text default null,
  p_next_day_plan text default null,
  p_issues text default null,
  p_consumptions jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid;
  v_report_id uuid;
  v_item jsonb;
  v_material public.project_materials%rowtype;
  v_quantity numeric(18,3);
begin
  if not public.can_manage_project_attendance(p_project_id) then
    raise exception 'Vous ne pouvez pas enregistrer le rapport de ce chantier.';
  end if;

  if p_report_date <> current_date then
    raise exception 'Seul le rapport du jour peut être modifié.';
  end if;

  select organization_id into v_organization_id from public.projects where id = p_project_id;
  if v_organization_id is null then
    raise exception 'Chantier introuvable.';
  end if;

  select id into v_report_id
  from public.project_daily_reports
  where project_id = p_project_id and report_date = p_report_date
  order by created_at desc
  limit 1
  for update;

  if v_report_id is null then
    insert into public.project_daily_reports (
      organization_id, project_id, report_date, weather, workers_present,
      completed_work, next_day_plan, issues, created_by
    ) values (
      v_organization_id, p_project_id, p_report_date, p_weather,
      greatest(coalesce(p_workers_present, 0), 0), p_completed_work,
      p_next_day_plan, p_issues, auth.uid()
    ) returning id into v_report_id;
  else
    if exists (
      select 1 from public.project_daily_reports
      where id = v_report_id and created_by is not null and created_by <> auth.uid()
    ) then
      raise exception 'Ce rapport a été créé par un autre utilisateur et est en lecture seule.';
    end if;
    update public.project_daily_reports
    set weather = p_weather,
        workers_present = greatest(coalesce(p_workers_present, 0), 0),
        completed_work = p_completed_work,
        next_day_plan = p_next_day_plan,
        issues = p_issues
    where id = v_report_id;
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_consumptions, '[]'::jsonb))
  loop
    v_quantity := (v_item ->> 'quantity')::numeric;
    if v_quantity is null or v_quantity <= 0 then
      raise exception 'Chaque consommation doit avoir une quantité positive.';
    end if;

    select * into v_material
    from public.project_materials
    where id = (v_item ->> 'material_id')::uuid and project_id = p_project_id
    for update;
    if not found then
      raise exception 'Matériau introuvable pour ce chantier.';
    end if;
    if coalesce(v_material.on_site_quantity, 0) < v_quantity then
      raise exception 'Stock insuffisant pour % : il reste % %.', v_material.designation, v_material.on_site_quantity, v_material.unit;
    end if;

    update public.project_materials
    set on_site_quantity = on_site_quantity - v_quantity,
        updated_at = now()
    where id = v_material.id;

    insert into public.project_report_material_usages (
      organization_id, project_id, report_id, material_id, quantity, unit, created_by
    ) values (
      v_organization_id, p_project_id, v_report_id, v_material.id, v_quantity, v_material.unit, auth.uid()
    ) on conflict (report_id, material_id) do update
      set quantity = public.project_report_material_usages.quantity + excluded.quantity,
          created_by = excluded.created_by;

    insert into public.project_stock_movements (
      organization_id, project_id, material_id, movement_type, quantity, movement_date, notes, created_by, report_id
    ) values (
      v_organization_id, p_project_id, v_material.id, 'consumption', v_quantity,
      p_report_date, 'Consommation déclarée dans le rapport journalier', auth.uid(), v_report_id
    );
  end loop;

  return v_report_id;
end;
$$;

create or replace function public.admin_delete_stock_movement(p_movement_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_movement public.project_stock_movements%rowtype;
  v_increase boolean;
begin
  select * into v_movement from public.project_stock_movements where id = p_movement_id for update;
  if not found then
    raise exception 'Mouvement introuvable.';
  end if;
  if not public.is_organization_admin(v_movement.organization_id) then
    raise exception 'Seul l''administrateur peut supprimer un mouvement de stock.';
  end if;

  v_increase := v_movement.movement_type in ('delivery', 'return', 'adjustment');
  if v_movement.material_id is not null then
    update public.project_materials
    set on_site_quantity = greatest(0, on_site_quantity + (case when v_increase then -1 else 1 end) * v_movement.quantity),
        updated_at = now()
    where id = v_movement.material_id;
  end if;

  if v_movement.report_id is not null and v_movement.material_id is not null then
    delete from public.project_report_material_usages
    where report_id = v_movement.report_id and material_id = v_movement.material_id;
  end if;

  delete from public.project_stock_movements where id = p_movement_id;
end;
$$;

revoke all on function public.admin_delete_stock_movement(uuid) from public;
grant execute on function public.admin_delete_stock_movement(uuid) to authenticated;

create or replace function public.admin_delete_material_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.project_material_orders%rowtype;
begin
  select * into v_order from public.project_material_orders where id = p_order_id for update;
  if not found then
    raise exception 'Demande introuvable.';
  end if;
  if not public.is_organization_admin(v_order.organization_id) then
    raise exception 'Seul l''administrateur peut supprimer une demande de matériau.';
  end if;

  if v_order.status = 'paid' and v_order.material_id is not null then
    update public.project_materials
    set on_site_quantity = greatest(0, on_site_quantity - coalesce(v_order.purchased_quantity, 0)),
        updated_at = now()
    where id = v_order.material_id;
  end if;

  delete from public.project_stock_movements where source_order_id = p_order_id;
  delete from public.project_material_orders where id = p_order_id;
end;
$$;

revoke all on function public.admin_delete_material_order(uuid) from public;
grant execute on function public.admin_delete_material_order(uuid) to authenticated;

create or replace function public.admin_delete_daily_report(p_report_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report public.project_daily_reports%rowtype;
  v_usage record;
begin
  select * into v_report from public.project_daily_reports where id = p_report_id for update;
  if not found then
    raise exception 'Rapport introuvable.';
  end if;
  if not public.is_organization_admin(v_report.organization_id) then
    raise exception 'Seul l''administrateur peut supprimer un rapport journalier.';
  end if;

  for v_usage in
    select * from public.project_report_material_usages where report_id = p_report_id
  loop
    update public.project_materials
    set on_site_quantity = on_site_quantity + v_usage.quantity,
        updated_at = now()
    where id = v_usage.material_id;
  end loop;

  delete from public.project_stock_movements where report_id = p_report_id;
  delete from public.project_report_material_usages where report_id = p_report_id;
  update public.project_photos set report_id = null where report_id = p_report_id;
  delete from public.project_daily_reports where id = p_report_id;
end;
$$;

revoke all on function public.admin_delete_daily_report(uuid) from public;
grant execute on function public.admin_delete_daily_report(uuid) to authenticated;
