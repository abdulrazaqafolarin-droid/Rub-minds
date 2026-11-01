-- Cover every new group-task foreign key so parent updates/deletes and
-- room-scoped access do not fall back to full-table scans.
-- The room-leading composite indexes also support per-room task joins.

create index if not exists room_task_dependencies_room_task_fk_idx
  on public.room_task_dependencies(room_id, task_id);
create index if not exists room_task_dependencies_creator_fk_idx
  on public.room_task_dependencies(created_by_participant_id);

create index if not exists room_task_submissions_room_task_fk_idx
  on public.room_task_submissions(room_id, task_id);
create index if not exists room_task_submissions_submitter_fk_idx
  on public.room_task_submissions(submitted_by_participant_id);

create index if not exists room_task_reviews_room_task_fk_idx
  on public.room_task_reviews(room_id, task_id);
create index if not exists room_task_reviews_reviewer_fk_idx
  on public.room_task_reviews(reviewer_participant_id);
