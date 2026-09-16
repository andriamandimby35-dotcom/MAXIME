-- Même défaut que les autres tables aujourd'hui : project_access_invitations
-- et project_assignments n'ont pas de GRANT pour service_role, ce qui bloque
-- silencieusement la modification et la suppression d'un accès (le bouton
-- Modifier/Supprimer utilise le client admin côté serveur).
grant select, insert, update, delete on public.project_access_invitations to authenticated, service_role;
grant select, insert, update, delete on public.project_assignments to authenticated, service_role;
