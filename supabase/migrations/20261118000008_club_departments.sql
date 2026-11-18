insert into public.departments (name) values
  ('PR'), ('LOCATION'), ('WORKSHOPS'), ('WELLFARE')
on conflict (name) do nothing;
