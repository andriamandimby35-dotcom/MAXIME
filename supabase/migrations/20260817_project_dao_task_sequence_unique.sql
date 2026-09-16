-- Empêche les doublons pendant les imports répétés du planning du DAO.
-- Un index unique standard autorise plusieurs valeurs NULL : les tâches ajoutées
-- manuellement restent donc possibles sans séquence DAO.
drop index if exists public.project_tasks_dao_sequence_unique;
create unique index project_tasks_dao_sequence_unique
  on public.project_tasks(project_id, dao_sequence);
