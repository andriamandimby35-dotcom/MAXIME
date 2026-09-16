-- project_materials est un registre de stock partagé qui évolue en continu
-- (quantité sur site, besoin prévu demain/semaine) : ce n'est pas une saisie
-- personnelle figée au jour de sa création, contrairement à ce que
-- reject_locked_project_record() suppose. Même défaut déjà corrigé pour
-- project_tasks (20260820_dao_tasks_no_daily_lock.sql) : un matériau créé
-- hier ne doit jamais devenir en lecture seule pour la mise à jour de son
-- stock ou de ses besoins prévus.
drop trigger if exists project_materials_daily_lock on public.project_materials;
