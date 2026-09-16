create or replace function public.debug_introspect()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'policies', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'table', tablename, 'policy', policyname, 'cmd', cmd, 'roles', roles,
        'qual', qual, 'with_check', with_check
      )), '[]'::jsonb)
      from pg_policies
      where schemaname = 'public'
        and tablename in ('project_assignments', 'project_access_invitations', 'project_tasks', 'project_material_orders')
    ),
    'triggers', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'table', c.relname,
        'trigger', t.tgname,
        'function', p.proname,
        'src', pg_get_functiondef(p.oid)
      )), '[]'::jsonb)
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_proc p on p.oid = t.tgfoid
      where c.relname in ('project_staff_members', 'project_tasks') and not t.tgisinternal
    ),
    'columns', (
      select coalesce(jsonb_agg(jsonb_build_object('name', column_name, 'type', data_type)), '[]'::jsonb)
      from information_schema.columns
      where table_schema = 'public' and table_name = 'project_staff_members'
    ),
    'functions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', p.proname,
        'args', pg_get_function_arguments(p.oid),
        'acl', p.proacl::text,
        'src', pg_get_functiondef(p.oid)
      )), '[]'::jsonb)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('is_organization_admin', 'can_access_project', 'can_view_project_record', 'can_manage_project_expenses', 'can_edit_project_record')
    )
  );
$$;
revoke all on function public.debug_introspect() from public;
grant execute on function public.debug_introspect() to service_role;
