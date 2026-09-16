create or replace function public.can_manage_project_expenses(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.projects p
    where p.id = target_project_id
      and (
        public.is_organization_admin(p.organization_id)
        or exists (
          select 1 from public.project_assignments a
          where a.project_id = p.id and a.user_id = auth.uid() and a.active
            and a.role in ('works_manager', 'site_manager')
            and coalesce((a.permissions ->> 'stock')::boolean, false)
        )
      )
  )
$$;
