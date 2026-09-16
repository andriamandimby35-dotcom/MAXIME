-- Un seul devis actif par DAO et par entreprise.
-- Les prix matériaux sont conservés : ils vivent dans price_library/price_history,
-- et ne sont jamais supprimés ici.
with duplicate_estimates as (
  select id,
         row_number() over (
           partition by organization_id, source_tender_id
           order by created_at desc, id desc
         ) as row_number
  from public.estimates
  where source_tender_id is not null
)
delete from public.estimate_lines
where estimate_id in (
  select id from duplicate_estimates where row_number > 1
);

with duplicate_estimates as (
  select id,
         row_number() over (
           partition by organization_id, source_tender_id
           order by created_at desc, id desc
         ) as row_number
  from public.estimates
  where source_tender_id is not null
)
delete from public.estimates
where id in (
  select id from duplicate_estimates where row_number > 1
);

create unique index if not exists estimates_one_per_organization_tender_unique
  on public.estimates (organization_id, source_tender_id)
  where source_tender_id is not null;
