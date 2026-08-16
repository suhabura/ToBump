-- Zaženi v Supabase SQL Editor (obstoječa baza)
insert into public.categories (name, icon) values
  ('Tenis', 'tennisball'),
  ('Nogomet', 'football'),
  ('Košarka', 'basketball')
on conflict (name) do nothing;
