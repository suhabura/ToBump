-- Fiktivni prijatelji za ToBump
-- Zaženi v Supabase → SQL Editor
-- Zamenjaj e-pošto spodaj, če je tvoj račun drug:

do $$
declare
  me_id uuid;
  friend_ids uuid[] := array[]::uuid[];
  fid uuid;
  names text[][] := array[
    array['Ana', 'Novak', 'ana.novak.demo@tobump.test'],
    array['Marko', 'Horvat', 'marko.horvat.demo@tobump.test'],
    array['Eva', 'Kovač', 'eva.kovac.demo@tobump.test'],
    array['Luka', 'Zupan', 'luka.zupan.demo@tobump.test']
  ];
  i int;
  new_id uuid;
begin
  select id into me_id
  from auth.users
  where email = 'jurekavas@gmail.com'
  limit 1;

  if me_id is null then
    raise exception 'Uporabnik jurekavas@gmail.com ni najden. Spremeni e-pošto v seed_friends.sql.';
  end if;

  for i in 1 .. array_length(names, 1) loop
    -- če uporabnik že obstaja, uporabi njega
    select id into new_id from auth.users where email = names[i][3] limit 1;

    if new_id is null then
      new_id := gen_random_uuid();

      insert into auth.users (
        instance_id,
        id,
        aud,
        role,
        email,
        encrypted_password,
        email_confirmed_at,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at,
        confirmation_token,
        recovery_token,
        email_change_token_new,
        email_change
      ) values (
        '00000000-0000-0000-0000-000000000000',
        new_id,
        'authenticated',
        'authenticated',
        names[i][3],
        crypt('DemoGeslo123!', gen_salt('bf')),
        now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('first_name', names[i][1], 'last_name', names[i][2]),
        now(),
        now(),
        '',
        '',
        '',
        ''
      );

      insert into auth.identities (
        id,
        user_id,
        identity_data,
        provider,
        provider_id,
        last_sign_in_at,
        created_at,
        updated_at
      ) values (
        gen_random_uuid(),
        new_id,
        jsonb_build_object('sub', new_id::text, 'email', names[i][3]),
        'email',
        names[i][3],
        now(),
        now(),
        now()
      );
    end if;

    -- posodobi profil (trigger morda že ustvari vrstico)
    insert into public.profiles (id, email, first_name, last_name)
    values (new_id, names[i][3], names[i][1], names[i][2])
    on conflict (id) do update
      set first_name = excluded.first_name,
          last_name = excluded.last_name,
          email = excluded.email;

    insert into public.user_settings (user_id)
    values (new_id)
    on conflict (user_id) do nothing;

    friend_ids := array_append(friend_ids, new_id);
  end loop;

  foreach fid in array friend_ids loop
    -- sprejeto prijateljstvo (jaz → prijatelj)
    insert into public.friendships (from_user_id, to_user_id, status)
    values (me_id, fid, 'accepted')
    on conflict (from_user_id, to_user_id) do update set status = 'accepted';

    -- in obratno, da je simetrično vidno
    insert into public.friendships (from_user_id, to_user_id, status)
    values (fid, me_id, 'accepted')
    on conflict (from_user_id, to_user_id) do update set status = 'accepted';
  end loop;
end $$;
