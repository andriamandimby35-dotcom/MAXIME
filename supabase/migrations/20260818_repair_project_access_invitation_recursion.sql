-- Évite la récursion des règles RLS entre invitations et affectations de chantier.
-- La fonction s'exécute avec les droits du propriétaire de la base, mais elle ne
-- retourne qu'un booléen : aucune donnée d'un autre chantier n'est exposée.

begin;

create or replace function public.can_create_project_access_invitation(
  target_organization_id uuid,
  target_project_id uuid,
  target_role text,
  target_parent_assignment_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1
      from public.organization_members member
      where member.organization_id = target_organization_id
        and member.user_id = auth.uid()
        and member.active = true
        and member.role in ('owner', 'admin')
    )
    or (
      target_role = 'site_manager'
      and exists (
        select 1
        from public.project_assignments assignment
        where assignment.id = target_parent_assignment_id
          and assignment.project_id = target_project_id
          and assignment.user_id = auth.uid()
          and assignment.active = true
          and assignment.role = 'works_manager'
      )
    );
$$;

revoke all on function public.can_create_project_access_invitation(uuid, uuid, text, uuid) from public;
grant execute on function public.can_create_project_access_invitation(uuid, uuid, text, uuid) to authenticated;

drop policy if exists project_access_invitations_insert
  on public.project_access_invitations;

create policy project_access_invitations_insert
  on public.project_access_invitations
  for insert
  to authenticated
  with check (
    invited_by = (select auth.uid())
    and public.can_create_project_access_invitation(
      organization_id,
      project_id,
      role,
      parent_assignment_id
    )
  );

commit;
