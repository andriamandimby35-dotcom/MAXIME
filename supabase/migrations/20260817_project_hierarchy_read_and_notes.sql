-- Consultation hiérarchique : chacun garde la maîtrise de ses propres saisies.
-- Les responsables lisent les données de leurs subordonnés directs, sans les modifier.

-- Compatibilité : cette colonne peut manquer si la migration des accès projet
-- n'a pas encore été exécutée. On la crée donc avant toute règle hiérarchique.
alter table public.project_assignments
  add column if not exists parent_assignment_id uuid references public.project_assignments(id) on delete set null;
alter table public.project_assignments
  add column if not exists permissions jsonb not null default '{}'::jsonb;
alter table public.project_assignments
  add column if not exists assigned_by uuid references auth.users(id) on delete set null;
create index if not exists project_assignments_parent_assignment_id_idx
  on public.project_assignments(parent_assignment_id);

-- Le module d'invitation est inclus ici afin que cette migration puisse être
-- exécutée seule sur une base qui n'a pas encore reçu les accès par chantier.
create table if not exists public.project_access_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  email text not null,
  role text not null check (role in ('works_manager', 'site_manager', 'viewer')),
  permissions jsonb not null default '{}'::jsonb,
  parent_assignment_id uuid references public.project_assignments(id) on delete set null,
  invited_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);
create unique index if not exists project_access_invitations_pending_email_unique
  on public.project_access_invitations(project_id, lower(email)) where status = 'pending';

create or replace function public.can_invite_project_subordinate(target_project_id uuid, requested_role text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_organization_admin((select organization_id from public.projects where id = target_project_id))
    or exists (
      select 1 from public.project_assignments a
      where a.project_id = target_project_id
        and a.user_id = auth.uid()
        and a.active
        and a.role = 'works_manager'
        and requested_role = 'site_manager'
    );
$$;
revoke all on function public.can_invite_project_subordinate(uuid, text) from public;
grant execute on function public.can_invite_project_subordinate(uuid, text) to authenticated;

alter table public.project_access_invitations enable row level security;
drop policy if exists project_access_invitations_insert on public.project_access_invitations;
drop policy if exists project_access_invitations_update on public.project_access_invitations;
create policy project_access_invitations_insert on public.project_access_invitations for insert to authenticated
  with check (
    invited_by = auth.uid()
    and public.can_invite_project_subordinate(project_id, role)
    and (
      public.is_organization_admin(organization_id)
      or (role = 'site_manager' and parent_assignment_id in (
        select id from public.project_assignments
        where project_id = project_access_invitations.project_id
          and user_id = auth.uid() and active and role = 'works_manager'
      ))
    )
  );
create policy project_access_invitations_update on public.project_access_invitations for update to authenticated
  using (public.is_organization_admin(organization_id) or invited_by = auth.uid())
  with check (public.is_organization_admin(organization_id) or invited_by = auth.uid());
grant select, insert, update on public.project_access_invitations to authenticated;

create or replace function public.accept_my_project_access_invitations()
returns integer language plpgsql security definer set search_path = public as $$
declare invitation record; accepted_count integer := 0; member_role text;
begin
  for invitation in select * from public.project_access_invitations
    where status = 'pending' and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  loop
    member_role := case when invitation.role = 'works_manager' then 'works_manager' else 'site_manager' end;
    insert into public.organization_members (organization_id, user_id, role, active)
    values (invitation.organization_id, auth.uid(), member_role, true)
    on conflict (organization_id, user_id) do update set active = true;
    insert into public.project_assignments (organization_id, project_id, user_id, role, active, permissions, parent_assignment_id, assigned_by)
    values (invitation.organization_id, invitation.project_id, auth.uid(), invitation.role, true, invitation.permissions, invitation.parent_assignment_id, invitation.invited_by)
    on conflict (project_id, user_id) do update set role = excluded.role, active = true,
      permissions = excluded.permissions, parent_assignment_id = excluded.parent_assignment_id,
      assigned_by = excluded.assigned_by, updated_at = now();
    update public.project_access_invitations set status = 'accepted', accepted_at = now() where id = invitation.id;
    accepted_count := accepted_count + 1;
  end loop;
  return accepted_count;
end;
$$;
revoke all on function public.accept_my_project_access_invitations() from public;
grant execute on function public.accept_my_project_access_invitations() to authenticated;

create or replace function public.can_view_project_record(
  target_project_id uuid,
  record_creator uuid
)
returns boolean language sql stable security definer set search_path = public as $$
  select
    public.can_access_project(target_project_id)
    and (
      record_creator is null -- éléments communs issus du DAO / du planning
      or record_creator = auth.uid()
      or exists (
        select 1
        from public.projects p
        where p.id = target_project_id
          and public.is_organization_admin(p.organization_id)
      )
      or exists (
        select 1
        from public.project_assignments supervisor
        join public.project_assignments subordinate
          on subordinate.parent_assignment_id = supervisor.id
        where supervisor.project_id = target_project_id
          and supervisor.user_id = auth.uid()
          and supervisor.active
          and supervisor.role = 'works_manager'
          and subordinate.project_id = target_project_id
          and subordinate.user_id = record_creator
          and subordinate.active
          and subordinate.role = 'site_manager'
      )
    );
$$;

revoke all on function public.can_view_project_record(uuid, uuid) from public;
grant execute on function public.can_view_project_record(uuid, uuid) to authenticated;

-- Le destinataire d'une remarque est résolu côté serveur à partir de la saisie
-- annotée. Ainsi, le chef voit les remarques déposées par son conducteur sans
-- obtenir un accès d'écriture aux données du conducteur.
alter table public.project_record_notes
  add column if not exists target_created_by uuid references auth.users(id) on delete set null;

create or replace function public.resolve_project_note_target_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  case new.entity_type
    when 'task' then
      select created_by into new.target_created_by from public.project_tasks where id = new.entity_id and project_id = new.project_id;
    when 'daily_report' then
      select created_by into new.target_created_by from public.project_daily_reports where id = new.entity_id and project_id = new.project_id;
    when 'material' then
      select created_by into new.target_created_by from public.project_materials where id = new.entity_id and project_id = new.project_id;
    when 'stock_movement' then
      select created_by into new.target_created_by from public.project_stock_movements where id = new.entity_id and project_id = new.project_id;
    when 'photo' then
      select created_by into new.target_created_by from public.project_photos where id = new.entity_id and project_id = new.project_id;
    when 'suggestion' then
      select created_by into new.target_created_by from public.project_ai_suggestions where id = new.entity_id and project_id = new.project_id;
    else
      raise exception 'Type de remarque non pris en charge: %', new.entity_type;
  end case;
  if not found then
    raise exception 'La saisie annotée est introuvable ou ne correspond pas à ce chantier';
  end if;
  return new;
end;
$$;

drop trigger if exists project_notes_resolve_target_owner on public.project_record_notes;
create trigger project_notes_resolve_target_owner
  before insert on public.project_record_notes
  for each row execute function public.resolve_project_note_target_owner();

create or replace function public.can_view_project_note(
  target_project_id uuid,
  note_creator uuid,
  target_creator uuid
)
returns boolean language sql stable security definer set search_path = public as $$
  select public.can_access_project(target_project_id)
    and (
      note_creator = auth.uid()
      or target_creator is null
      or target_creator = auth.uid()
      or public.can_view_project_record(target_project_id, target_creator)
    );
$$;

revoke all on function public.can_view_project_note(uuid, uuid, uuid) from public;
grant execute on function public.can_view_project_note(uuid, uuid, uuid) to authenticated;

drop policy if exists project_record_notes_read on public.project_record_notes;
create policy project_record_notes_read on public.project_record_notes for select to authenticated
  using (public.can_view_project_note(project_id, created_by, target_created_by));

-- Une remarque ne peut être déposée que sur une saisie que son auteur est
-- autorisé à consulter. Ainsi le chef ne peut pas annoter le travail de son
-- conducteur, alors que le conducteur peut annoter celui de son chef.
drop policy if exists project_record_notes_insert on public.project_record_notes;
create policy project_record_notes_insert on public.project_record_notes for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.can_view_project_record(project_id, target_created_by)
  );

-- Remplace les lectures générales par la lecture hiérarchique.
drop policy if exists project_tasks_read on public.project_tasks;
create policy project_tasks_read on public.project_tasks for select to authenticated
  using (public.can_view_project_record(project_id, created_by));

drop policy if exists project_reports_read on public.project_daily_reports;
create policy project_reports_read on public.project_daily_reports for select to authenticated
  using (public.can_view_project_record(project_id, created_by));

drop policy if exists project_materials_read on public.project_materials;
create policy project_materials_read on public.project_materials for select to authenticated
  using (public.can_view_project_record(project_id, created_by));

drop policy if exists project_stock_read on public.project_stock_movements;
create policy project_stock_read on public.project_stock_movements for select to authenticated
  using (public.can_view_project_record(project_id, created_by));

drop policy if exists project_photos_read on public.project_photos;
create policy project_photos_read on public.project_photos for select to authenticated
  using (public.can_view_project_record(project_id, created_by));

drop policy if exists project_suggestions_read on public.project_ai_suggestions;
create policy project_suggestions_read on public.project_ai_suggestions for select to authenticated
  using (public.can_view_project_record(project_id, created_by));

-- Les affectations suivent elles aussi la hiérarchie : chacun voit son accès,
-- le conducteur voit les chefs rattachés à son propre accès et l'administrateur
-- voit l'ensemble du chantier. Seul l'administrateur gère les affectations.
drop policy if exists project_assignments_access on public.project_assignments;
drop policy if exists project_assignments_read_hierarchy on public.project_assignments;
drop policy if exists project_assignments_admin_manage on public.project_assignments;
create policy project_assignments_read_hierarchy on public.project_assignments for select to authenticated
  using (
    public.is_organization_admin(organization_id)
    or user_id = auth.uid()
    or exists (
      select 1 from public.project_assignments supervisor
      where supervisor.id = project_assignments.parent_assignment_id
        and supervisor.project_id = project_assignments.project_id
        and supervisor.user_id = auth.uid()
        and supervisor.active
        and supervisor.role = 'works_manager'
    )
  );
create policy project_assignments_admin_manage on public.project_assignments for all to authenticated
  using (public.is_organization_admin(organization_id))
  with check (public.is_organization_admin(organization_id));

-- Les invitations ne sont visibles que par leur émetteur ou l'administrateur.
drop policy if exists project_access_invitations_read on public.project_access_invitations;
drop policy if exists project_access_invitations_read_hierarchy on public.project_access_invitations;
create policy project_access_invitations_read_hierarchy on public.project_access_invitations for select to authenticated
  using (public.is_organization_admin(organization_id) or invited_by = auth.uid());
