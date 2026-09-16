-- Module paie (salaire employés) et dépenses générales par chantier.

-- A. Numéro MVola par employé (juste stocké, non affiché ailleurs pour ne pas
-- perturber l'existant).
alter table public.project_staff_members
  add column if not exists mvola_number text;

-- A. Un lot de paiement de salaire = une "certification" que l'admin/conducteur
-- a payé les employés listés, avec le détail figé (nom, fonction, taux,
-- jours, montant) au moment du paiement, indépendamment de tout changement
-- futur sur project_staff_members.
create table if not exists public.project_salary_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  paid_by uuid references auth.users(id) on delete set null,
  paid_at timestamptz not null default now(),
  total_amount numeric(18,2) not null default 0,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null
);

create table if not exists public.project_salary_payment_lines (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.project_salary_payments(id) on delete cascade,
  staff_member_id uuid references public.project_staff_members(id) on delete set null,
  full_name text not null,
  role_name text,
  daily_rate numeric(18,2) not null default 0,
  days_worked integer not null default 0,
  amount numeric(18,2) not null default 0,
  mvola_number text
);

create index if not exists project_salary_payments_project_idx
  on public.project_salary_payments(project_id, paid_at desc);
create index if not exists project_salary_payment_lines_payment_idx
  on public.project_salary_payment_lines(payment_id);

alter table public.project_salary_payments enable row level security;
alter table public.project_salary_payment_lines enable row level security;

drop policy if exists project_salary_payments_access on public.project_salary_payments;
create policy project_salary_payments_access on public.project_salary_payments for all to authenticated
  using (public.can_access_project(project_id)) with check (public.can_access_project(project_id));

drop policy if exists project_salary_payment_lines_access on public.project_salary_payment_lines;
create policy project_salary_payment_lines_access on public.project_salary_payment_lines for all to authenticated
  using (exists (select 1 from public.project_salary_payments p where p.id = payment_id and public.can_access_project(p.project_id)))
  with check (exists (select 1 from public.project_salary_payments p where p.id = payment_id and public.can_access_project(p.project_id)));

grant select, insert, update, delete on public.project_salary_payments, public.project_salary_payment_lines to authenticated, service_role;

-- C. Le circuit d'achat couvre aussi le transport et les dépenses imprévues :
-- un même order peut être de type matériau, transport ou "autre" (imprévu).
alter table public.project_material_orders
  add column if not exists expense_kind text not null default 'material' check (expense_kind in ('material', 'transport', 'other')),
  add column if not exists transport_mode text check (transport_mode in ('homme', 'charrette', 'camionnette', 'camion', 'autre')),
  add column if not exists recipient_name text;

-- D. Suppression d'une ligne de "Compte dépense générale" : on garde une trace
-- de qui a supprimé quoi et quand, plutôt qu'un delete pur et simple.
alter table public.project_material_orders
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users(id) on delete set null;

do $$
begin
  alter publication supabase_realtime add table public.project_salary_payments;
exception
  when duplicate_object then null;
end $$;
