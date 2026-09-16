-- La fonction accept_my_project_access_invitations() et la création directe
-- de compte utilisent toutes deux "on conflict (organization_id, user_id)"
-- sur organization_members, mais aucune contrainte d'unicité ne l'appuyait.
create unique index if not exists organization_members_org_user_unique
  on public.organization_members(organization_id, user_id);
