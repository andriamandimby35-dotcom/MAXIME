-- La contrainte d'origine sur project_material_orders.status ne listait que
-- ('requested', 'paid', 'cancelled') ; le flux demande/validation ajouté
-- cette session utilise aussi 'submitted', 'approved', 'covered_by_stock'
-- et maintenant 'rejected' (bouton "Rejeter" admin). On élargit la
-- contrainte pour couvrir toutes les valeurs réellement utilisées.
alter table public.project_material_orders drop constraint if exists project_material_orders_status_check;
alter table public.project_material_orders add constraint project_material_orders_status_check
  check (status in ('requested', 'submitted', 'approved', 'covered_by_stock', 'paid', 'rejected', 'cancelled'));
