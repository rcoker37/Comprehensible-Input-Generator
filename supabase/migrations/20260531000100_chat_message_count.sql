-- Add message_count to the chats list RPC so the Chats list cards can show
-- how many messages each chat holds. Counts every message in the chat
-- (user + assistant, any status) so the number matches the conversation length
-- the user sees in the thread.

create or replace function public.get_chats_with_read_stats()
returns table (
  id bigint,
  title text,
  created_at timestamptz,
  last_activity_at timestamptz,
  message_count bigint,
  min_assistant_read_count int,
  last_read_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    c.id,
    c.title,
    c.created_at,
    c.last_activity_at,
    -- total messages in the chat (user + assistant, any status)
    (select count(*)
     from public.chat_messages m
     where m.chat_id = c.id) as message_count,
    -- MIN over complete assistant messages; NULL when there are none
    (select min(m.read_count)
     from public.chat_messages m
     where m.chat_id = c.id
       and m.role = 'assistant'
       and m.status = 'complete') as min_assistant_read_count,
    -- MAX last_read_at over complete assistant messages
    (select max(m.last_read_at)
     from public.chat_messages m
     where m.chat_id = c.id
       and m.role = 'assistant'
       and m.status = 'complete') as last_read_at
  from public.chats c
  where c.user_id = auth.uid()
  order by c.last_activity_at desc;
$$;
