-- Ces deux tables n'avaient jamais reçu les droits pour service_role (trouvé
-- en essayant d'y accéder avec la clé de service), contrairement au reste
-- des tables du dossier de soumission.
grant select, insert, update, delete on public.tender_submission_items to authenticated, service_role;
grant select, insert, update, delete on public.estimate_submission_dossiers to authenticated, service_role;
