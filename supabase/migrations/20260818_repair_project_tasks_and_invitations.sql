-- Réparation idempotente : import des tâches du DAO et création des accès chantier.
-- À exécuter une seule fois dans Supabase > SQL Editor.

alter table public.project_tasks add column if not exists dao_sequence integer;
alter table public.project_tasks add column if not exists source_reference text;
alter table public.project_tasks add column if not exists is_dao_task boolean not null default false;

create unique index if not exists project_tasks_dao_sequence_unique
  on public.project_tasks(project_id, dao_sequence)
  where dao_sequence is not null and is_dao_task;

alter table public.project_assignments
  add column if not exists parent_assignment_id uuid references public.project_assignments(id) on delete set null;
alter table public.project_assignments
  add column if not exists permissions jsonb not null default '{}'::jsonb;
alter table public.project_assignments
  add column if not exists assigned_by uuid references auth.users(id) on delete set null;

create table if not exists public.project_access_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  email text not null,
  role text not null check (role in ('works_manager', 'site_manager', 'viewer')),
  permissions jsonb not null default '{"reports": true, "stock": true, "photos": true}'::jsonb,
  parent_assignment_id uuid references public.project_assignments(id) on delete set null,
  invited_by uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  created_at timestamptz not null default timezone('utc', now()),
  accepted_at timestamptz
);

alter table public.project_access_invitations add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.project_access_invitations add column if not exists project_id uuid references public.projects(id) on delete cascade;
alter table public.project_access_invitations add column if not exists email text;
alter table public.project_access_invitations add column if not exists role text;
alter table public.project_access_invitations add column if not exists permissions jsonb not null default '{"reports": true, "stock": true, "photos": true}'::jsonb;
alter table public.project_access_invitations add column if not exists parent_assignment_id uuid references public.project_assignments(id) on delete set null;
alter table public.project_access_invitations add column if not exists invited_by uuid references auth.users(id) on delete set null;
alter table public.project_access_invitations add column if not exists status text not null default 'pending';
alter table public.project_access_invitations add column if not exists created_at timestamptz not null default timezone('utc', now());
alter table public.project_access_invitations add column if not exists accepted_at timestamptz;

create unique index if not exists project_access_invitations_pending_unique
  on public.project_access_invitations(project_id, lower(email))
  where status = 'pending';

alter table public.project_access_invitations enable row level security;

drop policy if exists project_access_invitations_read_organization on public.project_access_invitations;
create policy project_access_invitations_read_organization
  on public.project_access_invitations for select to authenticated
  using (
    exists (
      select 1 from public.organization_members member
      where member.organization_id = project_access_invitations.organization_id
        and member.user_id = (select auth.uid())
        and member.active
    )
  );

grant select on public.project_access_invitations to authenticated;

-- Lors de sa première connexion, le collaborateur invité reçoit son accès actif.
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
      assigned_by = excluded.assigned_by;

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
