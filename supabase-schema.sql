create extension if not exists pgcrypto;

do $$
begin
  create type public.user_role as enum ('teacher', 'student');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null check (char_length(display_name) between 1 and 40),
  role public.user_role not null,
  created_at timestamptz not null default now()
);

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  part text not null check (part in ('Part 1', 'Part 2 & 3')),
  title text not null,
  prompt text not null,
    tags text[] not null default '{}',
    topic_label text not null default '',
  p3_questions text[] not null default '{}',
  answer_notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.assignments (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  instructions text not null default '',
  due_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.assignment_questions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  question_id uuid references public.questions(id) on delete set null,
  question_snapshot jsonb not null,
  position integer not null default 0
);

create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  media_type text not null check (media_type in ('audio', 'video')),
  media_path text not null,
  duration_seconds integer not null default 0,
  reflection text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.feedbacks (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references public.submissions(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  fluency numeric(2,1) not null check (fluency between 0 and 9),
  vocabulary numeric(2,1) not null check (vocabulary between 0 and 9),
  grammar numeric(2,1) not null check (grammar between 0 and 9),
  pronunciation numeric(2,1) not null check (pronunciation between 0 and 9),
  feedback_text text not null,
  voice_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists questions_teacher_id_idx on public.questions(teacher_id);
create index if not exists assignments_teacher_id_idx on public.assignments(teacher_id);
create index if not exists assignments_student_id_idx on public.assignments(student_id);
create index if not exists assignment_questions_assignment_id_idx on public.assignment_questions(assignment_id);
create index if not exists submissions_assignment_id_idx on public.submissions(assignment_id);
create index if not exists submissions_student_id_idx on public.submissions(student_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists questions_set_updated_at on public.questions;
create trigger questions_set_updated_at
before update on public.questions
for each row execute procedure public.set_updated_at();

drop trigger if exists feedbacks_set_updated_at on public.feedbacks;
create trigger feedbacks_set_updated_at
before update on public.feedbacks
for each row execute procedure public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username, display_name, role)
  values (
    new.id,
    lower(new.raw_user_meta_data ->> 'username'),
    coalesce(new.raw_user_meta_data ->> 'display_name', '新用户'),
    coalesce((new.raw_user_meta_data ->> 'role')::public.user_role, 'student')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.is_teacher()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'teacher'
  );
$$;

grant execute on function public.is_teacher() to authenticated;

alter table public.profiles enable row level security;
alter table public.questions enable row level security;
alter table public.assignments enable row level security;
alter table public.assignment_questions enable row level security;
alter table public.submissions enable row level security;
alter table public.feedbacks enable row level security;

create policy "read own profile or teacher student list" on public.profiles
for select to authenticated
using (id = auth.uid() or (public.is_teacher() and role = 'student'));

create policy "teacher manages own questions" on public.questions
for all to authenticated
using (public.is_teacher() and teacher_id = auth.uid())
with check (public.is_teacher() and teacher_id = auth.uid());

create policy "teacher manages own assignments" on public.assignments
for all to authenticated
using (public.is_teacher() and teacher_id = auth.uid())
with check (public.is_teacher() and teacher_id = auth.uid());

create policy "student reads assigned work" on public.assignments
for select to authenticated
using (student_id = auth.uid());

create policy "assignment questions visible to assignment participants" on public.assignment_questions
for select to authenticated
using (
  exists (
    select 1 from public.assignments
    where assignments.id = assignment_questions.assignment_id
      and (assignments.student_id = auth.uid() or assignments.teacher_id = auth.uid())
  )
);

create policy "teacher manages assignment questions" on public.assignment_questions
for all to authenticated
using (
  public.is_teacher() and exists (
    select 1 from public.assignments
    where assignments.id = assignment_questions.assignment_id
      and assignments.teacher_id = auth.uid()
  )
)
with check (
  public.is_teacher() and exists (
    select 1 from public.assignments
    where assignments.id = assignment_questions.assignment_id
      and assignments.teacher_id = auth.uid()
  )
);

create policy "student creates and manages own submissions" on public.submissions
for all to authenticated
using (student_id = auth.uid())
with check (
  student_id = auth.uid() and exists (
    select 1 from public.assignments
    where assignments.id = submissions.assignment_id
      and assignments.student_id = auth.uid()
  )
);

create policy "teacher reads assigned student submissions" on public.submissions
for select to authenticated
using (
  public.is_teacher() and exists (
    select 1 from public.assignments
    where assignments.id = submissions.assignment_id
      and assignments.teacher_id = auth.uid()
  )
);

create policy "teacher manages feedback for own assignments" on public.feedbacks
for all to authenticated
using (
  public.is_teacher() and exists (
    select 1 from public.submissions
    join public.assignments on assignments.id = submissions.assignment_id
    where submissions.id = feedbacks.submission_id
      and assignments.teacher_id = auth.uid()
  )
)
with check (
  public.is_teacher() and teacher_id = auth.uid() and exists (
    select 1 from public.submissions
    join public.assignments on assignments.id = submissions.assignment_id
    where submissions.id = feedbacks.submission_id
      and assignments.teacher_id = auth.uid()
  )
);

create policy "student reads own feedback" on public.feedbacks
for select to authenticated
using (
  exists (
    select 1 from public.submissions
    where submissions.id = feedbacks.submission_id
      and submissions.student_id = auth.uid()
  )
);

insert into storage.buckets (id, name, public)
values ('speaking-media', 'speaking-media', false)
on conflict (id) do update set public = false;

create policy "users upload into own media folder" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'speaking-media'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "participants read related media" on storage.objects
for select to authenticated
using (
  bucket_id = 'speaking-media'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or exists (
      select 1 from public.submissions
      join public.assignments on assignments.id = submissions.assignment_id
      where submissions.media_path = name
        and assignments.teacher_id = auth.uid()
    )
    or exists (
      select 1 from public.feedbacks
      join public.submissions on submissions.id = feedbacks.submission_id
      where feedbacks.voice_path = name
        and submissions.student_id = auth.uid()
    )
  )
);

create policy "users delete own media" on storage.objects
for delete to authenticated
using (
  bucket_id = 'speaking-media'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- Optional administrator extension: for existing projects run
-- supabase-admin-migration.sql. It is repeated here so fresh installs are ready.
alter type public.user_role add value if not exists 'admin';

create table if not exists public.platform_settings (
  singleton boolean primary key default true check (singleton),
  teacher_invite_code text not null default 'dummyTT' check (char_length(teacher_invite_code) between 4 and 64),
  admin_setup_code text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

insert into public.platform_settings (singleton, teacher_invite_code, admin_setup_code)
values (true, 'dummyTT', 'admin-ielts-7y3pN2')
on conflict (singleton) do nothing;

create unique index if not exists profiles_single_admin_idx
on public.profiles ((role)) where role = 'admin';

create or replace function public.set_platform_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  return new;
end;
$$;

drop trigger if exists platform_settings_set_updated_at on public.platform_settings;
create trigger platform_settings_set_updated_at
before update on public.platform_settings
for each row execute procedure public.set_platform_settings_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  requested_role text := lower(coalesce(new.raw_user_meta_data ->> 'role', 'student'));
  registration_code text := coalesce(new.raw_user_meta_data ->> 'registration_code', '');
  settings public.platform_settings%rowtype;
begin
  if requested_role not in ('student', 'teacher', 'admin') then
    raise exception 'Unsupported account role';
  end if;

  select * into settings from public.platform_settings where singleton = true;

  if requested_role = 'teacher' and registration_code <> settings.teacher_invite_code then
    raise exception '教师邀请码不正确';
  end if;

  if requested_role = 'admin' then
    if settings.admin_setup_code is null
      or registration_code <> settings.admin_setup_code
      or exists (select 1 from public.profiles where role = 'admin') then
      raise exception '管理员初始化不可用';
    end if;
  end if;

  insert into public.profiles (id, username, display_name, role)
  values (
    new.id,
    lower(new.raw_user_meta_data ->> 'username'),
    coalesce(new.raw_user_meta_data ->> 'display_name', 'New user'),
    requested_role::public.user_role
  );

  if requested_role = 'admin' then
    update public.platform_settings set admin_setup_code = null where singleton = true;
  end if;

  return new;
end;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

grant execute on function public.is_admin() to authenticated;

alter table public.platform_settings enable row level security;

drop policy if exists "read own profile or teacher student list" on public.profiles;
create policy "read profiles by workspace role" on public.profiles
for select to authenticated
using (
  id = auth.uid()
  or (public.is_teacher() and role = 'student')
  or public.is_admin()
);

create policy "admins read platform settings" on public.platform_settings
for select to authenticated
using (public.is_admin());

create policy "admins update platform settings" on public.platform_settings
for update to authenticated
using (public.is_admin())
with check (public.is_admin());

create or replace function public.admin_create_user(
  p_username text,
  p_display_name text,
  p_role text,
  p_password text
)
returns uuid
language plpgsql
security definer set search_path = public, auth
as $$
declare
  user_id uuid := gen_random_uuid();
  normalized_username text := lower(trim(p_username));
  normalized_role text := lower(trim(p_role));
  current_invite_code text;
begin
  if not public.is_admin() then
    raise exception '仅管理员可以创建用户';
  end if;

  if normalized_role not in ('student', 'teacher') then
    raise exception '只能创建学生或教师账号';
  end if;

  if normalized_username !~ '^[a-z0-9_]{3,24}$' then
    raise exception '账号格式不正确';
  end if;

  if char_length(trim(p_display_name)) not between 1 and 40 then
    raise exception '用户名称长度不正确';
  end if;

  if char_length(p_password) < 6 then
    raise exception '密码至少需要 6 位';
  end if;

  select teacher_invite_code into current_invite_code from public.platform_settings where singleton = true;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000000', user_id, 'authenticated', 'authenticated',
    normalized_username || '@accounts.ielts-studio.invalid', crypt(p_password, gen_salt('bf')), now(),
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
    jsonb_build_object('username', normalized_username, 'display_name', trim(p_display_name), 'role', normalized_role, 'registration_code', current_invite_code),
    now(), now(), '', '', '', ''
  );

  return user_id;
exception
  when unique_violation then
    raise exception '该账号已存在';
end;
$$;

create or replace function public.admin_delete_user(p_user_id uuid)
returns void
language plpgsql
security definer set search_path = public, auth
as $$
declare
  target_role public.user_role;
begin
  if not public.is_admin() then
    raise exception '仅管理员可以删除用户';
  end if;

  if p_user_id = auth.uid() then
    raise exception '不能删除当前管理员账号';
  end if;

  select role into target_role from public.profiles where id = p_user_id;
  if target_role is null then raise exception '用户不存在'; end if;
  if target_role = 'admin' then raise exception '不能删除管理员账号'; end if;

  delete from auth.users where id = p_user_id;
end;
$$;

grant execute on function public.admin_create_user(text, text, text, text) to authenticated;
grant execute on function public.admin_delete_user(uuid) to authenticated;
