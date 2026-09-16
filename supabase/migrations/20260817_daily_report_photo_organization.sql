-- Chaque photo terrain est rattachée à un rapport journalier du même chantier.
alter table public.project_photos
  add column if not exists report_id uuid references public.project_daily_reports(id) on delete set null;

create index if not exists project_photos_report_idx
  on public.project_photos(project_id, report_id, captured_at desc);

create or replace function public.ensure_project_photo_report_matches_project()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.report_id is not null and not exists (
    select 1
    from public.project_daily_reports report
    where report.id = new.report_id
      and report.project_id = new.project_id
      and report.organization_id = new.organization_id
  ) then
    raise exception 'Le rapport journalier doit appartenir au même chantier et à la même organisation que la photo.';
  end if;
  return new;
end;
$$;

drop trigger if exists project_photo_report_same_project on public.project_photos;
create trigger project_photo_report_same_project
before insert or update of report_id, project_id, organization_id on public.project_photos
for each row execute function public.ensure_project_photo_report_matches_project();
