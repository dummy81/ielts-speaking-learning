alter table public.questions
  add column if not exists answer_notes text not null default '';

alter table public.questions
  add column if not exists topic_label text not null default '';
