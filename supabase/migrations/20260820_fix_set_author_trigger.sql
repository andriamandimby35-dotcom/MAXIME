create or replace function public.project_material_orders_set_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.requested_by is null then new.requested_by := auth.uid(); end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.project_staff_members_set_author_fn()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is null then new.created_by := auth.uid(); end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.project_daily_attendance_set_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.recorded_by is null then new.recorded_by := auth.uid(); end if;
  new.updated_at := now();
  return new;
end;
$$;

-- Repointe automatiquement tout trigger qui utilisait encore l'ancienne
-- fonction partagée (quel que soit son nom exact) vers la bonne fonction
-- dédiée à chaque table.
do $$
declare rec record;
begin
  for rec in
    select t.tgname, c.relname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where t.tgfoid = 'public.project_tracking_set_author'::regproc
      and not t.tgisinternal
  loop
    execute format('drop trigger %I on public.%I', rec.tgname, rec.relname);
    if rec.relname = 'project_material_orders' then
      execute format('create trigger %I before insert or update on public.%I for each row execute function public.project_material_orders_set_author()', rec.tgname, rec.relname);
    elsif rec.relname = 'project_staff_members' then
      execute format('create trigger %I before insert or update on public.%I for each row execute function public.project_staff_members_set_author_fn()', rec.tgname, rec.relname);
    elsif rec.relname = 'project_daily_attendance' then
      execute format('create trigger %I before insert or update on public.%I for each row execute function public.project_daily_attendance_set_author()', rec.tgname, rec.relname);
    end if;
  end loop;
end $$;
