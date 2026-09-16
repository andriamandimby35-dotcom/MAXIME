-- Un paiement entrant doit indiquer son origine (avancement, attachement ou
-- solde de fin de travaux) pour suivre l'avancement d'un marché public.
alter table public.payments add column if not exists payment_type text not null default 'avancement'
  check (payment_type in ('avancement', 'attachement', 'solde'));

grant select, insert, update, delete on public.payments to authenticated, service_role;
grant select, insert, update, delete on public.progress_claims to authenticated, service_role;
