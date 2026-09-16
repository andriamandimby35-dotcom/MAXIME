-- price_history a le GRANT nécessaire (20260819_price_library_grants.sql) mais
-- aucune policy RLS de lecture connue : l'historique reste vide côté
-- application (INSERT fonctionne, SELECT renvoie 0 ligne) tant qu'aucune
-- policy SELECT permissive n'existe pour authenticated.
drop policy if exists price_history_select_authenticated on public.price_history;
create policy price_history_select_authenticated on public.price_history for select to authenticated using (true);

drop policy if exists price_history_insert_authenticated on public.price_history;
create policy price_history_insert_authenticated on public.price_history for insert to authenticated with check (true);

drop policy if exists price_history_update_authenticated on public.price_history;
create policy price_history_update_authenticated on public.price_history for update to authenticated using (true) with check (true);

drop policy if exists price_history_delete_authenticated on public.price_history;
create policy price_history_delete_authenticated on public.price_history for delete to authenticated using (true);
