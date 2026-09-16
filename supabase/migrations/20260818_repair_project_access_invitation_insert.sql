-- Répare la création d'accès depuis l'application.
-- L'administrateur de l'organisation peut inviter un conducteur ou un lecteur.
-- Le conducteur peut uniquement inviter un chef de chantier qui lui est rattaché.

begin;

alter table public.project_access_invitations enable row level security;

drop policy if exists project_access_invitations_insert
  on public.project_access_invitations;

create policy project_access_invitations_insert
  on public.project_access_invitations
  for insert
  to authenticated
  with check (
    invited_by = (select auth.uid())
    and (
      exists (
        select 1
        from public.organization_members member
        where member.organization_id = project_access_invitations.organization_id
          and member.user_id = (select auth.uid())
          and member.active = true
          and member.role in ('owner', 'admin')
      )
      or (
        role = 'site_manager'
        and exists (
          select 1
          from public.project_assignments assignment
          where assignment.id = project_access_invitations.parent_assignment_id
            and assignment.project_id = project_access_invitations.project_id
            and assignment.user_id = (select auth.uid())
            and assignment.active = true
            and assignment.role = 'works_manager'
        )
      )
    )
  );

grant insert on public.project_access_invitations to authenticated;

commit;
