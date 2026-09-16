-- Suivi opérationnel des chantiers : toutes les données restent isolées par organisation.
create table if not exists public.project_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  status text not null default 'planned' check (status in ('planned','active','blocked','completed')),
  planned_start_date date,
  planned_end_date date,
  progress_percent numeric(5,2) not null default 0 check (progress_percent >= 0 and progress_percent <= 100),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_daily_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  report_date date not null default current_date,
  weather text,
  workers_present integer not null default 0 check (workers_present >= 0),
  completed_work text,
  next_day_plan text,
  issues text,
  created_at timestamptz not null default now(),
  unique(project_id, report_date)
);

create table if not exists public.project_materials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  designation text not null,
  unit text not null default 'U',
  planned_quantity numeric(18,3) not null default 0,
  on_site_quantity numeric(18,3) not null default 0,
  required_tomorrow numeric(18,3) not null default 0,
  required_week numeric(18,3) not null default 0,
  minimum_stock numeric(18,3) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_tasks_project_idx on public.project_tasks(project_id);
create index if not exists project_daily_reports_project_date_idx on public.project_daily_reports(project_id, report_date desc);
create index if not exists project_materials_project_idx on public.project_materials(project_id);

alter table public.project_tasks enable row level security;
alter table public.project_daily_reports enable row level security;
alter table public.project_materials enable row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array['project_tasks','project_daily_reports','project_materials'] loop
    execute format('create policy %I on public.%I for all to authenticated using (exists (select 1 from public.organization_members m where m.organization_id = %I.organization_id and m.user_id = (select auth.uid()))) with check (exists (select 1 from public.organization_members m where m.organization_id = %I.organization_id and m.user_id = (select auth.uid())))', table_name || '_own_organization', table_name, table_name, table_name);
  end loop;
exception when duplicate_object then null;
end $$;

grant select, insert, update, delete on public.project_tasks, public.project_daily_reports, public.project_materials to authenticated;
