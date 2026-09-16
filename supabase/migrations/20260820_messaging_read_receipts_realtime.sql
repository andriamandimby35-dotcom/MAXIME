alter table public.project_record_notes
  add column if not exists read_by jsonb not null default '[]'::jsonb;

do $$
begin
  alter publication supabase_realtime add table public.project_record_notes;
exception
  when duplicate_object then null;
end $$;

drop policy if exists project_record_notes_update on public.project_record_notes;
create policy project_record_notes_update on public.project_record_notes for update to authenticated
  using (public.can_access_project(project_id))
  with check (public.can_access_project(project_id));
