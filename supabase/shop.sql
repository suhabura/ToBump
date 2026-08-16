-- ToBump merchandise shop
-- Paste into Supabase SQL Editor → Run

create table if not exists public.shop_products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  price numeric(10,2) not null default 0,
  currency text not null default 'EUR',
  image_url text,
  category text not null default 'merch',
  stock int,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.shop_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  product_id uuid not null references public.shop_products(id) on delete restrict,
  quantity int not null default 1 check (quantity > 0),
  size text,
  note text,
  status text not null default 'requested'
    check (status in ('requested', 'confirmed', 'shipped', 'cancelled')),
  created_at timestamptz not null default now()
);

create index if not exists idx_shop_products_active on public.shop_products(is_active, sort_order);
create index if not exists idx_shop_orders_user on public.shop_orders(user_id, created_at desc);

alter table public.shop_products enable row level security;
alter table public.shop_orders enable row level security;

drop policy if exists "shop_products_select" on public.shop_products;
create policy "shop_products_select" on public.shop_products
  for select to authenticated
  using (is_active = true);

drop policy if exists "shop_orders_select" on public.shop_orders;
create policy "shop_orders_select" on public.shop_orders
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "shop_orders_insert" on public.shop_orders;
create policy "shop_orders_insert" on public.shop_orders
  for insert to authenticated
  with check (user_id = auth.uid());

grant select on public.shop_products to authenticated;
grant select, insert on public.shop_orders to authenticated;

-- Seed English product names (UI can localize labels later)
insert into public.shop_products (name, description, price, category, sort_order, stock)
select v.name, v.description, v.price, v.category, v.sort_order, v.stock
from (
  values
    ('ToBump Tee', 'Soft cotton tee with the ToBump mark. Unisex fit.', 24.00::numeric, 'apparel', 1, 50),
    ('ToBump Hoodie', 'Midweight hoodie for cool evenings after the match.', 49.00::numeric, 'apparel', 2, 30),
    ('ToBump Cap', 'Adjustable cap with embroidered logo.', 19.00::numeric, 'accessories', 3, 40),
    ('ToBump Bottle', '750 ml stainless bottle — stay hydrated between events.', 22.00::numeric, 'gear', 4, 60),
    ('ToBump Tote', 'Canvas tote for kit, snacks, and plans.', 16.00::numeric, 'accessories', 5, 80)
) as v(name, description, price, category, sort_order, stock)
where not exists (
  select 1 from public.shop_products p where lower(p.name) = lower(v.name)
);
