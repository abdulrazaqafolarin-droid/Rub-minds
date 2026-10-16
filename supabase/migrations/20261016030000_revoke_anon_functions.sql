-- Privileged functions are only intended for signed-in users.
revoke execute on function public.create_room_invite(uuid,integer,integer) from anon;
revoke execute on function public.create_room_with_owner(text,text) from anon;
revoke execute on function public.is_room_member(uuid) from anon;
revoke execute on function public.redeem_room_invite(text) from anon;
