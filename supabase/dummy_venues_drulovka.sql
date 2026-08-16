-- 10 dummy verified venues ~10–100 km from Drulovka (46.21465, 14.37142)
-- Paste into Supabase SQL Editor → Run
-- Safe to re-run: removes previous rows with the same dummy names first

delete from public.enterprises
where name like 'Dummy %from Drulovka%';

insert into public.enterprises (
  name, address, latitude, longitude, price, is_approved, provider_kind
) values
  (
    'Dummy Arena 10km from Drulovka',
    'Test venue · ~10 km N of Drulovka',
    46.304585, 14.371419,
    0, true, 'official'
  ),
  (
    'Dummy Court 20km from Drulovka',
    'Test venue · ~20 km NE of Drulovka',
    46.360064, 14.524611,
    5, true, 'tobump_booking'
  ),
  (
    'Dummy Hall 30km from Drulovka',
    'Test venue · ~30 km E of Drulovka',
    46.297424, 14.742800,
    0, true, 'official'
  ),
  (
    'Dummy Pitch 40km from Drulovka',
    'Test venue · ~40 km SE of Drulovka',
    46.102428, 14.864841,
    8, true, 'tobump_booking'
  ),
  (
    'Dummy Center 50km from Drulovka',
    'Test venue · ~50 km S of Drulovka',
    45.850239, 14.750873,
    0, true, 'official'
  ),
  (
    'Dummy Park 60km from Drulovka',
    'Test venue · ~60 km SW of Drulovka',
    45.675060, 14.371419,
    10, true, 'tobump_booking'
  ),
  (
    'Dummy Club 70km from Drulovka',
    'Test venue · ~70 km W of Drulovka',
    45.704125, 13.841576,
    0, true, 'official'
  ),
  (
    'Dummy Dome 80km from Drulovka',
    'Test venue · ~80 km NW of Drulovka',
    45.988088, 13.386600,
    12, true, 'tobump_booking'
  ),
  (
    'Dummy Field 90km from Drulovka',
    'Test venue · ~90 km NNW of Drulovka',
    46.459341, 13.253938,
    0, true, 'official'
  ),
  (
    'Dummy Stadium 100km from Drulovka',
    'Test venue · ~100 km NNW of Drulovka',
    46.939630, 13.597215,
    15, true, 'tobump_booking'
  );
