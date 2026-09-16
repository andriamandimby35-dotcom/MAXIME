-- Accès par chantier et tâches provenant du planning du DAO.
-- L'administrateur invite un conducteur ; le conducteur peut ensuite inviter
-- un chef de chantier uniquement pour le même chantier.

alter table public.project_tasks add column if not exists dao_sequence integer;
alter table public.project_tasks add column if not exists source_reference text;
alter table public.project_tasks add column if not exists is_dao_task boolean not null default false;
create unique index if not exists project_tasks_dao_sequence_unique
  on public.project_tasks(project_id, dao_sequence)
  where dao_sequence is not null;

alter table public.project_assignments add column if not exists parent_assignment_id uuid references public.project_assignments(id) on delete set null;
alter table public.project_assignments add column if not exists permissions jsonb not null default '{}'::jsonb;
alter table public.project_assignments add column if not exists assigned_by uuid references auth.users(id) on delete set null;

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
drop policy if exists project_access_invitations_read on public.project_access_invitations;
drop policy if exists project_access_invitations_insert on public.project_access_invitations;
drop policy if exists project_access_invitations_update on public.project_access_invitations;
create policy project_access_invitations_read on public.project_access_invitations for select to authenticated
  using (public.can_access_project(project_id));
create policy project_access_invitations_insert on public.project_access_invitations for insert to authenticated
  with check (
    invited_by = auth.uid()
    and public.can_invite_project_subordinate(project_id, role)
    and (
      public.is_organization_admin(organization_id)
      or (role = 'site_manager' and parent_assignment_id in (
        select id from public.project_assignments
        where project_id = project_access_invitations.project_id
          and user_id = auth.uid()
          and active and role = 'works_manager'
      ))
    )
  );
create policy project_access_invitations_update on public.project_access_invitations for update to authenticated
  using (public.is_organization_admin(organization_id) or invited_by = auth.uid())
  with check (public.is_organization_admin(organization_id) or invited_by = auth.uid());
grant select, insert, update on public.project_access_invitations to authenticated;

-- À la première connexion du collaborateur invité, son accès devient effectif.
create or replace function public.accept_my_project_access_invitations()
returns integer language plpgsql security definer set search_path = public as $$
declare
  invitation record;
  accepted_count integer := 0;
  member_role text;
begin
  for invitation in
    select * from public.project_access_invitations
    where status = 'pending'
      and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  loop
    member_role := case when invitation.role = 'works_manager' then 'works_manager' else 'site_manager' end;
    insert into public.organization_members (organization_id, user_id, role, active)
    values (invitation.organization_id, auth.uid(), member_role, true)
    on conflict (organization_id, user_id) do update set active = true;

    insert into public.project_assignments (
      organization_id, project_id, user_id, role, active,
      permissions, parent_assignment_id, assigned_by
    ) values (
      invitation.organization_id, invitation.project_id, auth.uid(), invitation.role, true,
      invitation.permissions, invitation.parent_assignment_id, invitation.invited_by
    )
    on conflict (project_id, user_id) do update set
      role = excluded.role,
      active = true,
      permissions = excluded.permissions,
      parent_assignment_id = excluded.parent_assignment_id,
      assigned_by = excluded.assigned_by,
      updated_at = now();

    update public.project_access_invitations
      set status = 'accepted', accepted_at = now()
      where id = invitation.id;
    accepted_count := accepted_count + 1;
  end loop;
  return accepted_count;
end;
$$;

revoke all on function public.accept_my_project_access_invitations() from public;
grant execute on function public.accept_my_project_access_invitations() to authenticated;
