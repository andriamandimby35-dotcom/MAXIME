alter table public.estimates add column if not exists profit_margin_percent numeric(8,3) not null default 0 check (profit_margin_percent >= 0 and profit_margin_percent <= 1000);
