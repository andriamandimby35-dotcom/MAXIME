alter table public.project_material_orders
  add column if not exists seen_at timestamptz,
  add column if not exists needed_timing text check (needed_timing in ('now', 'tomorrow', 'week'));

do $$
begin
  alter publication supabase_realtime add table public.project_material_orders;
exception
  when duplicate_object then null;
end $$;
