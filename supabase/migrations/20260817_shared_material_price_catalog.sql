-- Un matériau commun, plusieurs observations de prix historisées.
create table if not exists public.shared_material_prices (
  id uuid primary key default gen_random_uuid(),
  designation_key text not null,
  designation text not null,
  categorie text,
  unite text not null,
  prix_unitaire numeric not null check (prix_unitaire >= 0),
  currency text not null default 'MGA',
  provenance_label text not null,
  provenance_url text,
  contributor_organization_id uuid references public.organizations(id) on delete set null,
  contributor_organization_name text,
  supplier_name text,
  supplier_city text,
  supplier_region text,
  confidence numeric,
  first_seen_at timestamptz not null default now(),
  last_checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  unique (designation_key, unite)
);

create table if not exists public.shared_material_price_observations (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.shared_material_prices(id) on delete cascade,
  prix_unitaire numeric not null check (prix_unitaire >= 0),
  currency text not null default 'MGA',
  provenance_type text not null check (provenance_type in ('internet_ia', 'saisie_manuelle_entreprise')),
  provenance_label text not null,
  provenance_url text,
  contributor_organization_id uuid references public.organizations(id) on delete set null,
  contributor_organization_name text,
  supplier_name text,
  supplier_city text,
  supplier_region text,
  confidence numeric,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create index if not exists shared_material_prices_lookup_idx on public.shared_material_prices (designation_key, unite);
create index if not exists shared_material_price_observations_material_idx on public.shared_material_price_observations (material_id, observed_at desc);

alter table public.shared_material_prices enable row level security;
alter table public.shared_material_price_observations enable row level security;

drop policy if exists shared_material_prices_read_authenticated on public.shared_material_prices;
drop policy if exists shared_material_prices_insert_authenticated on public.shared_material_prices;
drop policy if exists shared_material_prices_update_owner on public.shared_material_prices;
drop policy if exists shared_material_prices_update_authenticated on public.shared_material_prices;
drop policy if exists shared_material_prices_delete_owner on public.shared_material_prices;
create policy shared_material_prices_read_authenticated on public.shared_material_prices for select to authenticated using (true);
create policy shared_material_prices_insert_authenticated on public.shared_material_prices for insert to authenticated with check (created_by = (select auth.uid()));
create policy shared_material_prices_update_authenticated on public.shared_material_prices for update to authenticated using (true) with check (true);
create policy shared_material_prices_delete_owner on public.shared_material_prices for delete to authenticated using (created_by = (select auth.uid()));

drop policy if exists shared_material_price_observations_read_authenticated on public.shared_material_price_observations;
drop policy if exists shared_material_price_observations_insert_authenticated on public.shared_material_price_observations;
create policy shared_material_price_observations_read_authenticated on public.shared_material_price_observations for select to authenticated using (true);
create policy shared_material_price_observations_insert_authenticated on public.shared_material_price_observations for insert to authenticated with check (created_by = (select auth.uid()));

grant select, insert, update, delete on public.shared_material_prices to authenticated;
grant select, insert on public.shared_material_price_observations to authenticated;

-- Stockage privé des pièces jointes et PDF de soumission.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('btp-documents', 'btp-documents', false, 52428800, array['application/pdf', 'image/jpeg', 'image/png', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do nothing;

drop policy if exists btp_documents_select_own_organization on storage.objects;
drop policy if exists btp_documents_insert_own_organization on storage.objects;
drop policy if exists btp_documents_update_own_organization on storage.objects;
drop policy if exists btp_documents_delete_own_organization on storage.objects;
create policy btp_documents_select_own_organization on storage.objects for select to authenticated using (
  bucket_id = 'btp-documents' and exists (select 1 from public.organization_members m where m.user_id = (select auth.uid()) and m.organization_id::text = (storage.foldername(name))[1])
);
create policy btp_documents_insert_own_organization on storage.objects for insert to authenticated with check (
  bucket_id = 'btp-documents' and exists (select 1 from public.organization_members m where m.user_id = (select auth.uid()) and m.organization_id::text = (storage.foldername(name))[1])
);
create policy btp_documents_update_own_organization on storage.objects for update to authenticated using (
  bucket_id = 'btp-documents' and exists (select 1 from public.organization_members m where m.user_id = (select auth.uid()) and m.organization_id::text = (storage.foldername(name))[1])
) with check (
  bucket_id = 'btp-documents' and exists (select 1 from public.organization_members m where m.user_id = (select auth.uid()) and m.organization_id::text = (storage.foldername(name))[1])
);
create policy btp_documents_delete_own_organization on storage.objects for delete to authenticated using (
  bucket_id = 'btp-documents' and exists (select 1 from public.organization_members m where m.user_id = (select auth.uid()) and m.organization_id::text = (storage.foldername(name))[1])
);
