-- Les tables estimates/estimate_lines/estimate_documents n'avaient jamais reçu
-- de GRANT explicite (contrairement aux autres tables du projet), ce qui
-- bloquait aussi bien les requêtes authenticated que le client service_role
-- utilisé côté serveur pour la suppression (app/api/estimates/[id]/route.ts).
grant select, insert, update, delete on public.estimates to authenticated, service_role;
grant select, insert, update, delete on public.estimate_lines to authenticated, service_role;
grant select, insert, update, delete on public.estimate_documents to authenticated, service_role;
