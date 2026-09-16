create or replace function public.reject_locked_project_task()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not old.is_dao_task and old.created_at::date < current_date then
    raise exception 'Cette saisie est verrouillée car elle a été synchronisée un jour précédent.'
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists project_tasks_daily_lock on public.project_tasks;
create trigger project_tasks_daily_lock
  before update or delete on public.project_tasks
  for each row execute function public.reject_locked_project_task();
