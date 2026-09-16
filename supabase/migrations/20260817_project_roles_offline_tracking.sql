-- Accès opérationnel, rapports terrain, photos, stocks et audit hors ligne.
-- Un compte principal reste administrateur ; les autres utilisateurs sont limités
-- aux chantiers qui leur sont explicitement attribués.

alter table public.organization_members add column if not exists role text not null default 'admin';
alter table public.organization_members add column if not exists active boolean not null default true;
update public.organization_members set role = 'admin' where role is null or btrim(role) = '';

create table if not exists public.project_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('works_manager', 'site_manager', 'viewer')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, user_id)
);

create table if not exists public.project_stock_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  material_id uuid references public.project_materials(id) on delete set null,
  movement_type text not null check (movement_type in ('delivery', 'consumption', 'loss', 'return', 'adjustment')),
  quantity numeric(18,3) not null,
  movement_date date not null default current_date,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.project_photos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  task_id uuid references public.project_tasks(id) on delete set null,
  storage_path text not null,
  caption text,
  photo_type text not null default 'progress' check (photo_type in ('progress', 'issue', 'delivery', 'safety', 'other')),
  captured_at timestamptz not null default now(),
  latitude numeric(10,7),
  longitude numeric(10,7),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.project_ai_suggestions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  suggestion_type text not null check (suggestion_type in ('progress', 'material_need', 'stock_alert', 'photo_issue', 'planning_risk', 'safety')),
  title text not null,
  content text not null,
  confidence numeric(5,2),
  source_snapshot jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'modified')),
  user_response text,
  responded_by uuid references auth.users(id) on delete set null,
  responded_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.project_sync_events (
  id uuid primary key default gen_random_uuid(),
  client_operation_id uuid not null unique,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  entity_type text not null,
  entity_id uuid,
  operation text not null check (operation in ('create', 'update', 'delete')),
  payload jsonb not null default '{}'::jsonb,
  sync_state text not null default 'confirmed' check (sync_state in ('pending', 'confirmed', 'conflict', 'failed')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create index if not exists project_assignments_user_idx on public.project_assignments(user_id, project_id) where active;
create index if not exists project_stock_movements_project_idx on public.project_stock_movements(project_id, movement_date desc);
create index if not exists project_photos_project_idx on public.project_photos(project_id, captured_at desc);
create index if not exists project_ai_suggestions_project_idx on public.project_ai_suggestions(project_id, created_at desc);
create index if not exists project_sync_events_project_idx on public.project_sync_events(project_id, created_at desc);

-- Fonctions de contrôle centralisées : la sécurité ne dépend jamais seulement de l'interface.
create or replace function public.is_organization_admin(target_organization_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = target_organization_id
      and m.user_id = auth.uid()
      and coalesce(m.active, true)
      and coalesce(m.role, 'admin') in ('owner', 'admin')
  );
$$;

create or replace function public.can_access_project(target_project_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.projects p
    where p.id = target_project_id
      and (
        public.is_organization_admin(p.organization_id)
        or exists (
          select 1 from public.project_assignments a
          where a.project_id = p.id and a.user_id = auth.uid() and a.active
        )
      )
  );
$$;

revoke all on function public.is_organization_admin(uuid) from public;
revoke all on function public.can_access_project(uuid) from public;
grant execute on function public.is_organization_admin(uuid), public.can_access_project(uuid) to authenticated;

alter table public.project_assignments enable row level security;
alter table public.project_stock_movements enable row level security;
alter table public.project_photos enable row level security;
alter table public.project_ai_suggestions enable row level security;
alter table public.project_sync_events enable row level security;

drop policy if exists project_assignments_access on public.project_assignments;
create policy project_assignments_access on public.project_assignments for all to authenticated
  using (public.is_organization_admin(organization_id) or public.can_access_project(project_id))
  with check (public.is_organization_admin(organization_id));

drop policy if exists project_stock_movements_access on public.project_stock_movements;
create policy project_stock_movements_access on public.project_stock_movements for all to authenticated
  using (public.can_access_project(project_id)) with check (public.can_access_project(project_id));

drop policy if exists project_photos_access on public.project_photos;
create policy project_photos_access on public.project_photos for all to authenticated
  using (public.can_access_project(project_id)) with check (public.can_access_project(project_id));

drop policy if exists project_ai_suggestions_access on public.project_ai_suggestions;
create policy project_ai_suggestions_access on public.project_ai_suggestions for all to authenticated
  using (public.can_access_project(project_id)) with check (public.can_access_project(project_id));

drop policy if exists project_sync_events_access on public.project_sync_events;
create policy project_sync_events_access on public.project_sync_events for all to authenticated
  using (public.can_access_project(project_id)) with check (public.can_access_project(project_id));

-- Les tables opérationnelles créées précédemment sont maintenant également filtrées par chantier.
drop policy if exists project_tasks_own_organization on public.project_tasks;
create policy project_tasks_project_access on public.project_tasks for all to authenticated
  using (public.can_access_project(project_id)) with check (public.can_access_project(project_id));
drop policy if exists project_daily_reports_own_organization on public.project_daily_reports;
create policy project_daily_reports_project_access on public.project_daily_reports for all to authenticated
  using (public.can_access_project(project_id)) with check (public.can_access_project(project_id));
drop policy if exists project_materials_own_organization on public.project_materials;
create policy project_materials_project_access on public.project_materials for all to authenticated
  using (public.can_access_project(project_id)) with check (public.can_access_project(project_id));
drop policy if exists projects_all_org on public.projects;
create policy projects_project_access on public.projects for all to authenticated
  using (public.can_access_project(id))
  with check (public.is_organization_admin(organization_id));

grant select, insert, update, delete on public.project_assignments, public.project_stock_movements, public.project_photos, public.project_ai_suggestions, public.project_sync_events to authenticated;
