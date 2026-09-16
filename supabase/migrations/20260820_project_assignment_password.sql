-- Stocke le mot de passe défini par l'administrateur à la création d'un
-- accès conducteur/chef de chantier, pour qu'il puisse le reconsulter plus
-- tard. Ce champ n'est jamais renvoyé au navigateur d'un compte non admin
-- (filtré côté serveur) : seule l'organisation qui l'a créé peut le lire.
alter table public.project_assignments add column if not exists access_password text;
