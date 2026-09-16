drop policy if exists project_tasks_dao_update on public.project_tasks;
create policy project_tasks_dao_update on public.project_tasks for update to authenticated
  using (is_dao_task and public.can_access_project(project_id))
  with check (is_dao_task and public.can_access_project(project_id));
