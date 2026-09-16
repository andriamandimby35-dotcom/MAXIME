-- Certains matériaux sont exprimés dans le DAO dans une unité de mesure (ml,
-- kg, m²...) mais ne se vendent sur le marché qu'en pièce/barre entière d'une
-- taille fixe (ex: bois carré vendu en barres de 4 m à 7000 Ar, jamais au
-- mètre ni à la moitié de barre). Ces trois colonnes optionnelles permettent
-- de le déclarer une fois dans la bibliothèque de prix ; le devis calcule
-- alors automatiquement le nombre de pièces entières à acheter (arrondi au
-- supérieur, jamais de fraction de pièce) au lieu d'une simple règle de trois.
alter table public.price_library
  add column if not exists unite_achat text,
  add column if not exists quantite_par_unite_achat numeric,
  add column if not exists prix_unite_achat numeric;
