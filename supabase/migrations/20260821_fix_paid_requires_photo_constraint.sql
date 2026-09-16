-- La contrainte project_material_orders_paid_requires_photo (créée hors
-- migrations, directement dans Supabase) exige une photo sur TOUTE ligne
-- "paid", quel que soit expense_kind. C'est correct pour un achat de
-- matériau, mais bloquait deux circuits qui n'ont jamais de photo par
-- conception : le transport (qui réutilise désormais la photo de l'achat
-- parent — voir ProjectSiteManager.tsx) et les dépenses imprévues/"autre"
-- (juste bénéficiaire + montant, aucune photo prévue).
alter table public.project_material_orders drop constraint if exists project_material_orders_paid_requires_photo;
alter table public.project_material_orders add constraint project_material_orders_paid_requires_photo
  check (status <> 'paid' or expense_kind <> 'material' or purchase_photo_path is not null);
