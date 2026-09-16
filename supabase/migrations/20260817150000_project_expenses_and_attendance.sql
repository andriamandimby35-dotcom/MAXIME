-- Dépenses, demandes d'approvisionnement et présence quotidienne par chantier.
-- Les montants restent séparés par chantier et l'historique des jours passés est verrouillé.

create table if not exists public.project_material_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  material_id uuid references public.project_materials(id) on delete set null,
  material_name text not null,
  material_key text not null,
  unit text not null default 'U',
  quantity numeric not null check (quantity > 0),
  unit_price numeric not null default 0 check (unit_price >= 0),
  needed_date date not null default current_date,
  status text not null default 'requested' check (status in ('requested', 'paid', 'cancelled')),
  notes text,
  requested_by uuid references auth.users(id) on delete set null,
  validated_by uuid references auth.users(id) on delete set null,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_material_orders_project_status_idx
  on public.project_material_orders(project_id, status, needed_date desc);
create index if not exists project_material_orders_material_key_idx
  on public.project_material_orders(material_key);

create table if not exists public.project_staff_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  full_name text not null,
  role_name text not null default 'Ouvrier',
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, full_name)
);

create table if not exists public.project_daily_attendance (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  staff_member_id uuid not null references public.project_staff_members(id) on delete cascade,
  report_date date not null default current_date,
  present boolean not null default false,
  recorded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, staff_member_id, report_date)
);

create or replace function public.normalize_project_material_key(value text)
returns text language sql immutable as $$
  select regexp_replace(lower(translate(coalesce(value, ''),
    'àâäáãåçèéêëìíîïñòóôöõùúûüýÿ',
    'aaaaaaceeeeiiiinooooouuuuyy')), '[^a-z0-9]+', '', 'g')
$$;

create or replace function public.can_manage_project_expenses(target_project_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.projects p
    where p.id = target_project_id
      and (
        public.is_organization_admin(p.organization_id)
        or exists (
          select 1 from public.project_assignments a
          where a.project_id = p.id and a.user_id = auth.uid() and a.active
            and a.role = 'works_manager'
            and coalesce((a.permissions ->> 'stock')::boolean, false)
        )
      )
  )
$$;

create or replace function public.can_manage_project_attendance(target_project_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.projects p
    where p.id = target_project_id
      and (
        public.is_organization_admin(p.organization_id)
        or exists (
          select 1 from public.project_assignments a
          where a.project_id = p.id and a.user_id = auth.uid() and a.active
            and a.role in ('works_manager', 'site_manager')
            and coalesce((a.permissions ->> 'reports')::boolean, false)
        )
      )
  )
$$;

create or replace function public.project_tracking_set_author()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'project_material_orders' and new.requested_by is null then
    new.requested_by := auth.uid();
  elsif tg_table_name = 'project_staff_members' and new.created_by is null then
    new.created_by := auth.uid();
  elsif tg_table_name = 'project_daily_attendance' and new.recorded_by is null then
    new.recorded_by := auth.uid();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists project_material_orders_set_author on public.project_material_orders;
create trigger project_material_orders_set_author before insert or update on public.project_material_orders
for each row execute function public.project_tracking_set_author();
drop trigger if exists project_staff_members_set_author on public.project_staff_members;
create trigger project_staff_members_set_author before insert or update on public.project_staff_members
for each row execute function public.project_tracking_set_author();
drop trigger if exists project_daily_attendance_set_author on public.project_daily_attendance;
create trigger project_daily_attendance_set_author before insert or update on public.project_daily_attendance
for each row execute function public.project_tracking_set_author();

-- Les demandes et présences antérieures à aujourd'hui sont figées pour tous.
drop trigger if exists project_material_orders_daily_lock on public.project_material_orders;
create trigger project_material_orders_daily_lock before update or delete on public.project_material_orders
for each row execute function public.reject_locked_project_record();
drop trigger if exists project_daily_attendance_daily_lock on public.project_daily_attendance;
create trigger project_daily_attendance_daily_lock before update or delete on public.project_daily_attendance
for each row execute function public.reject_locked_project_record();

alter table public.project_material_orders enable row level security;
alter table public.project_staff_members enable row level security;
alter table public.project_daily_attendance enable row level security;

drop policy if exists project_material_orders_read on public.project_material_orders;
create policy project_material_orders_read on public.project_material_orders for select to authenticated
using (public.can_access_project(project_id));
drop policy if exists project_material_orders_insert on public.project_material_orders;
create policy project_material_orders_insert on public.project_material_orders for insert to authenticated
with check (public.can_manage_project_expenses(project_id) and requested_by = auth.uid());
drop policy if exists project_material_orders_update on public.project_material_orders;
create policy project_material_orders_update on public.project_material_orders for update to authenticated
using (public.is_organization_admin(organization_id) or public.can_edit_project_record(project_id, organization_id, requested_by, created_at))
with check (public.can_manage_project_expenses(project_id));
drop policy if exists project_material_orders_delete on public.project_material_orders;
create policy project_material_orders_delete on public.project_material_orders for delete to authenticated
using (public.is_organization_admin(organization_id) or public.can_edit_project_record(project_id, organization_id, requested_by, created_at));

drop policy if exists project_staff_members_read on public.project_staff_members;
create policy project_staff_members_read on public.project_staff_members for select to authenticated
using (public.can_access_project(project_id));
drop policy if exists project_staff_members_manage on public.project_staff_members;
create policy project_staff_members_manage on public.project_staff_members for all to authenticated
using (public.can_manage_project_expenses(project_id)) with check (public.can_manage_project_expenses(project_id));

drop policy if exists project_daily_attendance_read on public.project_daily_attendance;
create policy project_daily_attendance_read on public.project_daily_attendance for select to authenticated
using (public.can_access_project(project_id));
drop policy if exists project_daily_attendance_insert on public.project_daily_attendance;
create policy project_daily_attendance_insert on public.project_daily_attendance for insert to authenticated
with check (public.can_manage_project_attendance(project_id) and recorded_by = auth.uid());
drop policy if exists project_daily_attendance_update on public.project_daily_attendance;
create policy project_daily_attendance_update on public.project_daily_attendance for update to authenticated
using (public.is_organization_admin(organization_id) or public.can_edit_project_record(project_id, organization_id, recorded_by, created_at))
with check (public.can_manage_project_attendance(project_id));
drop policy if exists project_daily_attendance_delete on public.project_daily_attendance;
create policy project_daily_attendance_delete on public.project_daily_attendance for delete to authenticated
using (public.is_organization_admin(organization_id) or public.can_edit_project_record(project_id, organization_id, recorded_by, created_at));

grant select, insert, update, delete on public.project_material_orders, public.project_staff_members, public.project_daily_attendance to authenticated;
