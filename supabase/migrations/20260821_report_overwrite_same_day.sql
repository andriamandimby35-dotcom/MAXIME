-- Un seul rapport journalier existe par chantier et par jour. Il était
-- jusqu'ici verrouillé à son créateur : un autre poste envoyant le rapport
-- du même jour se voyait bloqué, ce qui créait de la confusion ("pourquoi
-- ça ne s'envoie pas ?"). On retire ce verrou : la dernière personne qui
-- envoie le rapport du jour écrase la précédente saisie, pour éviter les
-- doublons au lieu de bloquer l'envoi.
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
    -- Écrase la saisie existante du jour, quel que soit son créateur
    -- d'origine : évite les rapports en double plutôt que de bloquer.
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
      organization_id, project_id, material_id, movement_type, quantity, movement_date, notes, created_by
    ) values (
      v_organization_id, p_project_id, v_material.id, 'consumption', v_quantity,
      p_report_date, 'Consommation déclarée dans le rapport journalier', auth.uid()
    );
  end loop;

  return v_report_id;
end;
$$;
