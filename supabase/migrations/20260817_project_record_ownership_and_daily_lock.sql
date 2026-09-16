-- Verrouillage des saisies terrain : un utilisateur ne modifie pas les données
-- d'un autre niveau, et toute saisie synchronisée la veille devient une archive.

alter table public.project_tasks add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.project_daily_reports add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.project_materials add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.project_ai_suggestions add column if not exists created_by uuid references auth.users(id) on delete set null;

create table if not exists public.project_record_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  entity_type text not null check (entity_type in ('task', 'daily_report', 'material', 'stock_movement', 'photo', 'suggestion')),
  entity_id uuid not null,
  severity text not null default 'review' check (severity in ('info', 'review', 'urgent')),
  title text not null default 'Remarque de suivi',
  content text not null check (char_length(btrim(content)) > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists project_record_notes_entity_idx
  on public.project_record_notes(project_id, entity_type, entity_id, created_at desc);

create or replace function public.project_record_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

create or replace function public.can_edit_project_record(
  target_project_id uuid,
  target_organization_id uuid,
  record_creator uuid,
  record_created_at timestamptz
)
returns boolean language sql stable security definer set search_path = public as $$
  select record_created_at::date >= current_date
    -- Aucun niveau hiérarchique ne réécrit la saisie d'un autre :
    -- le supérieur consulte et ajoute éventuellement une remarque.
    and record_creator = auth.uid()
    and public.can_access_project(target_project_id);
$$;

revoke all on function public.can_edit_project_record(uuid, uuid, uuid, timestamptz) from public;
grant execute on function public.can_edit_project_record(uuid, uuid, uuid, timestamptz) to authenticated;

create or replace function public.reject_locked_project_record()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.created_at::date < current_date then
    raise exception 'Cette saisie est verrouillée car elle a été synchronisée un jour précédent.'
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists project_tasks_assign_creator on public.project_tasks;
create trigger project_tasks_assign_creator before insert on public.project_tasks
  for each row execute function public.project_record_before_insert();
drop trigger if exists project_reports_assign_creator on public.project_daily_reports;
create trigger project_reports_assign_creator before insert on public.project_daily_reports
  for each row execute function public.project_record_before_insert();
drop trigger if exists project_materials_assign_creator on public.project_materials;
create trigger project_materials_assign_creator before insert on public.project_materials
  for each row execute function public.project_record_before_insert();
drop trigger if exists project_suggestions_assign_creator on public.project_ai_suggestions;
create trigger project_suggestions_assign_creator before insert on public.project_ai_suggestions
  for each row execute function public.project_record_before_insert();
drop trigger if exists project_notes_assign_creator on public.project_record_notes;
create trigger project_notes_assign_creator before insert on public.project_record_notes
  for each row execute function public.project_record_before_insert();

drop trigger if exists project_tasks_daily_lock on public.project_tasks;
create trigger project_tasks_daily_lock before update or delete on public.project_tasks
  for each row execute function public.reject_locked_project_record();
drop trigger if exists project_reports_daily_lock on public.project_daily_reports;
create trigger project_reports_daily_lock before update or delete on public.project_daily_reports
  for each row execute function public.reject_locked_project_record();
drop trigger if exists project_materials_daily_lock on public.project_materials;
create trigger project_materials_daily_lock before update or delete on public.project_materials
  for each row execute function public.reject_locked_project_record();
drop trigger if exists project_photos_daily_lock on public.project_photos;
create trigger project_photos_daily_lock before update or delete on public.project_photos
  for each row execute function public.reject_locked_project_record();
drop trigger if exists project_stock_daily_lock on public.project_stock_movements;
create trigger project_stock_daily_lock before update or delete on public.project_stock_movements
  for each row execute function public.reject_locked_project_record();

alter table public.project_record_notes enable row level security;
drop policy if exists project_record_notes_read on public.project_record_notes;
drop policy if exists project_record_notes_insert on public.project_record_notes;
create policy project_record_notes_read on public.project_record_notes for select to authenticated
  using (public.can_access_project(project_id));
create policy project_record_notes_insert on public.project_record_notes for insert to authenticated
  with check (public.can_access_project(project_id) and created_by = auth.uid());
-- Les remarques sont un journal : aucune modification ni suppression n'est autorisée.

grant select, insert on public.project_record_notes to authenticated;

-- Chaque opération est divisée : lecture pour les personnes affectées, écriture
-- uniquement par l'auteur du jour ou par l'administrateur de l'organisation.
drop policy if exists project_tasks_project_access on public.project_tasks;
drop policy if exists project_tasks_read on public.project_tasks;
drop policy if exists project_tasks_insert on public.project_tasks;
drop policy if exists project_tasks_update on public.project_tasks;
drop policy if exists project_tasks_delete on public.project_tasks;
create policy project_tasks_read on public.project_tasks for select to authenticated
  using (public.can_access_project(project_id));
create policy project_tasks_insert on public.project_tasks for insert to authenticated
  with check (public.can_access_project(project_id) and created_by = auth.uid());
create policy project_tasks_update on public.project_tasks for update to authenticated
  using (public.can_edit_project_record(project_id, organization_id, created_by, created_at))
  with check (public.can_edit_project_record(project_id, organization_id, created_by, created_at));
create policy project_tasks_delete on public.project_tasks for delete to authenticated
  using (public.can_edit_project_record(project_id, organization_id, created_by, created_at));

drop policy if exists project_daily_reports_project_access on public.project_daily_reports;
drop policy if exists project_reports_read on public.project_daily_reports;
drop policy if exists project_reports_insert on public.project_daily_reports;
drop policy if exists project_reports_update on public.project_daily_reports;
drop policy if exists project_reports_delete on public.project_daily_reports;
create policy project_reports_read on public.project_daily_reports for select to authenticated
  using (public.can_access_project(project_id));
create policy project_reports_insert on public.project_daily_reports for insert to authenticated
  with check (public.can_access_project(project_id) and created_by = auth.uid());
create policy project_reports_update on public.project_daily_reports for update to authenticated
  using (public.can_edit_project_record(project_id, organization_id, created_by, created_at))
  with check (public.can_edit_project_record(project_id, organization_id, created_by, created_at));
create policy project_reports_delete on public.project_daily_reports for delete to authenticated
  using (public.can_edit_project_record(project_id, organization_id, created_by, created_at));

drop policy if exists project_materials_project_access on public.project_materials;
drop policy if exists project_materials_read on public.project_materials;
drop policy if exists project_materials_insert on public.project_materials;
drop policy if exists project_materials_update on public.project_materials;
drop policy if exists project_materials_delete on public.project_materials;
create policy project_materials_read on public.project_materials for select to authenticated
  using (public.can_access_project(project_id));
create policy project_materials_insert on public.project_materials for insert to authenticated
  with check (public.can_access_project(project_id) and created_by = auth.uid());
create policy project_materials_update on public.project_materials for update to authenticated
  using (public.can_edit_project_record(project_id, organization_id, created_by, created_at))
  with check (public.can_edit_project_record(project_id, organization_id, created_by, created_at));
create policy project_materials_delete on public.project_materials for delete to authenticated
  using (public.can_edit_project_record(project_id, organization_id, created_by, created_at));

drop policy if exists project_photos_access on public.project_photos;
drop policy if exists project_photos_read on public.project_photos;
drop policy if exists project_photos_insert on public.project_photos;
drop policy if exists project_photos_update on public.project_photos;
drop policy if exists project_photos_delete on public.project_photos;
create policy project_photos_read on public.project_photos for select to authenticated
  using (public.can_access_project(project_id));
create policy project_photos_insert on public.project_photos for insert to authenticated
  with check (public.can_access_project(project_id) and created_by = auth.uid());
create policy project_photos_update on public.project_photos for update to authenticated
  using (public.can_edit_project_record(project_id, organization_id, created_by, created_at))
  with check (public.can_edit_project_record(project_id, organization_id, created_by, created_at));
create policy project_photos_delete on public.project_photos for delete to authenticated
  using (public.can_edit_project_record(project_id, organization_id, created_by, created_at));

drop policy if exists project_stock_movements_access on public.project_stock_movements;
drop policy if exists project_stock_read on public.project_stock_movements;
drop policy if exists project_stock_insert on public.project_stock_movements;
drop policy if exists project_stock_update on public.project_stock_movements;
drop policy if exists project_stock_delete on public.project_stock_movements;
create policy project_stock_read on public.project_stock_movements for select to authenticated
  using (public.can_access_project(project_id));
create policy project_stock_insert on public.project_stock_movements for insert to authenticated
  with check (public.can_access_project(project_id) and created_by = auth.uid());
create policy project_stock_update on public.project_stock_movements for update to authenticated
  using (public.can_edit_project_record(project_id, organization_id, created_by, created_at))
  with check (public.can_edit_project_record(project_id, organization_id, created_by, created_at));
create policy project_stock_delete on public.project_stock_movements for delete to authenticated
  using (public.can_edit_project_record(project_id, organization_id, created_by, created_at));

drop policy if exists project_ai_suggestions_access on public.project_ai_suggestions;
drop policy if exists project_suggestions_read on public.project_ai_suggestions;
drop policy if exists project_suggestions_insert on public.project_ai_suggestions;
drop policy if exists project_suggestions_update on public.project_ai_suggestions;
create policy project_suggestions_read on public.project_ai_suggestions for select to authenticated
  using (public.can_access_project(project_id));
create policy project_suggestions_insert on public.project_ai_suggestions for insert to authenticated
  with check (public.can_access_project(project_id) and created_by = auth.uid());
create policy project_suggestions_update on public.project_ai_suggestions for update to authenticated
  using (public.can_edit_project_record(project_id, organization_id, created_by, created_at))
  with check (public.can_edit_project_record(project_id, organization_id, created_by, created_at));
