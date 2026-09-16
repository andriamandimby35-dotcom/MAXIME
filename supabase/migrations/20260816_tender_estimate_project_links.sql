-- Relations explicites : un devis et un chantier peuvent provenir d'un DAO.
alter table public.estimates add column if not exists source_tender_id uuid references public.tenders(id) on delete cascade;
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_tender_id uuid references public.tenders(id) on delete cascade,
  project_code text,
  name text not null,
  location text,
  budget_amount numeric(18,2) not null default 0,
  progress_percent numeric(5,2) not null default 0,
  start_date date,
  planned_end_date date,
  status text not null default 'planned',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.projects add column if not exists source_tender_id uuid references public.tenders(id) on delete cascade;
create index if not exists estimates_source_tender_idx on public.estimates(source_tender_id);
create unique index if not exists projects_source_tender_unique on public.projects(source_tender_id) where source_tender_id is not null;
alter table public.projects enable row level security;
do $$ begin
  create policy projects_all_org on public.projects for all to authenticated
  using (exists (select 1 from public.organization_members m where m.organization_id = projects.organization_id and m.user_id = (select auth.uid())))
  with check (exists (select 1 from public.organization_members m where m.organization_id = projects.organization_id and m.user_id = (select auth.uid())));
exception when duplicate_object then null; end $$;
grant select, insert, update, delete on public.projects to authenticated;
