-- Comme estimates/estimate_lines/estimate_documents, price_library et
-- price_history ont été créées hors des migrations suivies et n'ont jamais
-- reçu de GRANT explicite pour authenticated/service_role. Un contrôle direct
-- montre que le rôle service_role reçoit "permission denied for table
-- price_library" alors que les données (86 lignes) existent bien en base :
-- la bibliothèque de prix est donc invisible/inutilisable côté application
-- pour la même raison que le blocage de suppression des devis.
grant select, insert, update, delete on public.price_library to authenticated, service_role;
grant select, insert, update, delete on public.price_history to authenticated, service_role;
