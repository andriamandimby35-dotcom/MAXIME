drop policy if exists project_record_notes_read on public.project_record_notes;
create policy project_record_notes_read on public.project_record_notes for select to authenticated
  using (public.can_access_project(project_id));

drop policy if exists project_record_notes_insert on public.project_record_notes;
create policy project_record_notes_insert on public.project_record_notes for insert to authenticated
  with check (created_by = auth.uid() and public.can_access_project(project_id));
