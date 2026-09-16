-- Réparation idempotente pour les projets créés avant l'import du planning DAO.
-- Elle peut être exécutée sans supprimer les tâches ou les rapports existants.

alter table public.project_tasks add column if not exists dao_sequence integer;
alter table public.project_tasks add column if not exists source_reference text;
alter table public.project_tasks add column if not exists is_dao_task boolean not null default false;

-- Seules les tâches issues du DAO doivent être uniques par ordre. Les tâches
-- manuelles conservent le droit d'être ajoutées sans entrer en conflit.
drop index if exists public.project_tasks_dao_sequence_unique;
create unique index if not exists project_tasks_dao_sequence_unique
  on public.project_tasks(project_id, dao_sequence)
  where dao_sequence is not null and is_dao_task;
