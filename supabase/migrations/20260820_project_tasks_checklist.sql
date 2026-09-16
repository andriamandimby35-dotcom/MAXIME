alter table public.project_tasks
  add column if not exists checklist jsonb not null default '[]'::jsonb;
