-- Auto-actualisation sans rechargement de page sur le reste de l'application
-- (devis, prix, chantiers, appels d'offres, facturation, clients, documents),
-- même principe déjà en place sur l'Espace chantier et les Dépenses.
do $$ begin alter publication supabase_realtime add table public.tenders; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.estimates; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.estimate_lines; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.projects; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.project_assignments; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.project_tasks; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.price_library; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.price_history; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.payments; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.clients; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.documents; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.tender_submission_items; exception when duplicate_object then null; end $$;
