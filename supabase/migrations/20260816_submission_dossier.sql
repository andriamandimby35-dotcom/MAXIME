-- Dossier de soumission réutilisable par organisation.
-- Les informations générales restent dans un JSON pour pouvoir s'adapter aux
-- formulaires très différents d'un DAO à l'autre, sans réinventer le profil.
create table if not exists public.organization_submission_profiles (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  profile_data jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tender_submission_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  tender_id uuid not null references public.tenders(id) on delete cascade,
  kind text not null check (kind in ('document_to_provide', 'form_to_complete')),
  title text not null,
  source_reference text not null default '',
  instructions text not null default '',
  required boolean not null default true,
  status text not null default 'missing' check (status in ('missing', 'needs_information', 'ready', 'uploaded')),
  fields jsonb not null default '[]'::jsonb,
  form_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, tender_id, kind, title)
);

-- Un devis peut reprendre le même DAO, mais son état de préparation doit rester
-- indépendant des autres devis créés pour ce DAO.
create table if not exists public.estimate_submission_dossiers (
  estimate_id uuid primary key references public.estimates(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  tender_id uuid not null references public.tenders(id) on delete cascade,
  items jsonb not null default '[]'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, tender_id, estimate_id)
);

create index if not exists tender_submission_items_tender_org_idx
  on public.tender_submission_items(tender_id, organization_id);

alter table public.organization_submission_profiles enable row level security;
alter table public.tender_submission_items enable row level security;
alter table public.estimate_submission_dossiers enable row level security;

do $$ begin
  create policy organization_submission_profiles_all_org on public.organization_submission_profiles
  for all to authenticated
  using (exists (select 1 from public.organization_members m where m.organization_id = organization_submission_profiles.organization_id and m.user_id = (select auth.uid())))
  with check (exists (select 1 from public.organization_members m where m.organization_id = organization_submission_profiles.organization_id and m.user_id = (select auth.uid())));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy estimate_submission_dossiers_all_org on public.estimate_submission_dossiers
  for all to authenticated
  using (exists (select 1 from public.organization_members m where m.organization_id = estimate_submission_dossiers.organization_id and m.user_id = (select auth.uid())))
  with check (exists (select 1 from public.organization_members m where m.organization_id = estimate_submission_dossiers.organization_id and m.user_id = (select auth.uid())));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy tender_submission_items_all_org on public.tender_submission_items
  for all to authenticated
  using (exists (select 1 from public.organization_members m where m.organization_id = tender_submission_items.organization_id and m.user_id = (select auth.uid())))
  with check (exists (select 1 from public.organization_members m where m.organization_id = tender_submission_items.organization_id and m.user_id = (select auth.uid())));
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.organization_submission_profiles, public.tender_submission_items, public.estimate_submission_dossiers to authenticated;
