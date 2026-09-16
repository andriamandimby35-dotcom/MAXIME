create or replace function public.is_supervisor_of_assignment(target_parent_assignment_id uuid, target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.project_assignments supervisor
    where supervisor.id = target_parent_assignment_id
      and supervisor.project_id = target_project_id
      and supervisor.user_id = auth.uid()
      and supervisor.active
      and supervisor.role = 'works_manager'
  );
$$;
revoke all on function public.is_supervisor_of_assignment(uuid, uuid) from public;
grant execute on function public.is_supervisor_of_assignment(uuid, uuid) to authenticated;

drop policy if exists project_assignments_read_hierarchy on public.project_assignments;
create policy project_assignments_read_hierarchy on public.project_assignments for select to authenticated
  using (
    public.is_organization_admin(organization_id)
    or user_id = auth.uid()
    or public.is_supervisor_of_assignment(parent_assignment_id, project_id)
  );
