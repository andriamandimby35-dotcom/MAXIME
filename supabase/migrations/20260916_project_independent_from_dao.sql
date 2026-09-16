-- Le chantier (projects) devient indépendant de l'analyse DAO : la
-- localisation et le bordereau de prix sont copiés une seule fois depuis le
-- devis d'origine, au lieu d'être relus en direct dans les DAO à chaque
-- ouverture de la page. On garde une référence au devis d'origine pour
-- pouvoir rafraîchir la copie plus tard si besoin, mais ce n'est plus une
-- dépendance obligatoire.

alter table public.projects
  add column if not exists source_estimate_id uuid references public.estimates(id) on delete set null;

create unique index if not exists projects_source_estimate_unique
  on public.projects (source_estimate_id)
  where source_estimate_id is not null;

-- Bordereau de prix du chantier : copie indépendante des lignes du devis
-- d'origine (désignation, unité, quantité, prix unitaire, total).
create table if not exists public.project_price_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  position text,
  designation text not null,
  unit text,
  quantity numeric(18,3),
  unit_price numeric(18,2),
  total numeric(18,2),
  is_internal boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists project_price_items_project_idx on public.project_price_items(project_id);

alter table public.project_price_items enable row level security;

do $$ begin
  create policy project_price_items_all_org on public.project_price_items for all to authenticated
    using (exists (select 1 from public.organization_members m where m.organization_id = project_price_items.organization_id and m.user_id = (select auth.uid())))
    with check (exists (select 1 from public.organization_members m where m.organization_id = project_price_items.organization_id and m.user_id = (select auth.uid())));
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.project_price_items to authenticated, service_role;

-- Sécurité : s'assurer que les tables déjà utilisées par le chantier et les
-- devis ont bien les autorisations nécessaires (certaines en manquaient).
grant select, insert, update, delete on public.projects to authenticated, service_role;
grant select, insert, update, delete on public.estimates to authenticated, service_role;
grant select, insert, update, delete on public.estimate_lines to authenticated, service_role;
grant select, insert, update, delete on public.estimate_documents to authenticated, service_role;
