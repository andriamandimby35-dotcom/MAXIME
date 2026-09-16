-- Clôture automatique d'un chantier : les accès opérationnels sont désactivés,
-- tandis que les rapports et archives restent consultables.
create or replace function public.deactivate_project_access_on_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.progress_percent, 0) >= 100
     or lower(coalesce(new.status, '')) = 'completed' then
    new.progress_percent := 100;
    new.status := 'completed';

    update public.project_assignments
       set active = false
     where project_id = new.id
       and active = true
       and role in ('works_manager', 'site_manager', 'viewer');

    if to_regclass('public.project_access_invitations') is not null then
      execute
        'update public.project_access_invitations
           set status = ''revoked''
         where project_id = $1
           and status = ''pending'''
        using new.id;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists projects_deactivate_access_on_completion on public.projects;
create trigger projects_deactivate_access_on_completion
before insert or update of progress_percent, status
on public.projects
for each row
execute function public.deactivate_project_access_on_completion();

-- Applique aussi la règle aux chantiers déjà terminés.
update public.projects
   set progress_percent = 100,
       status = 'completed'
 where coalesce(progress_percent, 0) >= 100
    or lower(coalesce(status, '')) = 'completed';
