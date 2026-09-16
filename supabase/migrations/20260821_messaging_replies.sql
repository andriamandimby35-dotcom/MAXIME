-- Chaque remarque peut recevoir une réponse (un espace de réponse, pas un
-- fil illimité) avec sa propre gravité (erreur grave / point à contrôler /
-- confirmation) et son propre suivi de lecture, pour permettre l'état
-- "nouvelle réponse non lue" distinct de la remarque d'origine.
alter table public.project_record_notes
  add column if not exists reply_content text,
  add column if not exists reply_severity text check (reply_severity in ('urgent', 'review', 'confirmation')),
  add column if not exists replied_by uuid references auth.users(id) on delete set null,
  add column if not exists replied_at timestamptz,
  add column if not exists reply_read_by jsonb not null default '[]'::jsonb;
