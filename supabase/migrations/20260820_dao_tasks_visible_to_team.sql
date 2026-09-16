drop policy if exists project_tasks_read on public.project_tasks;
create policy project_tasks_read on public.project_tasks for select to authenticated
  using (
    public.can_access_project(project_id)
    and (is_dao_task or public.can_view_project_record(project_id, created_by))
  );
