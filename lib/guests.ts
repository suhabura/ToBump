import { supabase } from '@/lib/supabase';
import { createExpense, seriesKey } from '@/lib/finance';
import type { ActivityGuest, ActivityGuestAttendance } from '@/lib/types';

export type GuestAttendanceWithGuest = ActivityGuestAttendance & {
  activity_guests?: Pick<ActivityGuest, 'id' | 'name' | 'series_id'> | null;
};

export type SeriesGuestWithStats = ActivityGuest & {
  attendance_count: number;
  total_paid: number;
  attended_this?: boolean;
};

export async function fetchActivityGuests(activityId: string): Promise<GuestAttendanceWithGuest[]> {
  const { data, error } = await supabase
    .from('activity_guest_attendances')
    .select('*, activity_guests(id, name, series_id)')
    .eq('activity_id', activityId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data as GuestAttendanceWithGuest[]) ?? [];
}

export async function fetchSeriesGuests(seriesId: string): Promise<SeriesGuestWithStats[]> {
  const { data: guests, error } = await supabase
    .from('activity_guests')
    .select('*')
    .eq('series_id', seriesId)
    .order('name', { ascending: true });
  if (error) throw error;

  const { data: atts } = await supabase
    .from('activity_guest_attendances')
    .select('guest_id, amount, is_free, activity_id')
    .eq('series_id', seriesId);

  const byGuest = new Map<string, { count: number; paid: number }>();
  for (const a of atts ?? []) {
    const cur = byGuest.get(a.guest_id) ?? { count: 0, paid: 0 };
    cur.count += 1;
    if (!a.is_free) cur.paid += Number(a.amount) || 0;
    byGuest.set(a.guest_id, cur);
  }

  return ((guests as ActivityGuest[]) ?? []).map((g) => {
    const s = byGuest.get(g.id) ?? { count: 0, paid: 0 };
    return {
      ...g,
      attendance_count: s.count,
      total_paid: Math.round(s.paid * 100) / 100,
    };
  });
}

export async function addGuestToActivity(input: {
  activityId: string;
  name: string;
  amount: number;
  feeTreatment: 'none' | 'split_all';
  memberIds?: string[];
  /** Existing series guest id — reuse instead of creating by name */
  guestId?: string;
}): Promise<string> {
  const amount = input.amount > 0 ? input.amount : 0;
  const feeTreatment = amount > 0 ? input.feeTreatment : 'none';

  // Prefer RPC (creates guest + attendance + optional expense atomically)
  const { data, error } = await supabase.rpc('add_activity_guest', {
    p_activity_id: input.activityId,
    p_name: input.name.trim(),
    p_amount: amount,
    p_fee_treatment: feeTreatment,
    p_member_ids: input.memberIds ?? null,
  });

  if (!error) return data as string;

  // Fallback without RPC: client-side inserts
  if (!/function|does not exist/i.test(error.message)) throw error;

  const { data: act, error: aErr } = await supabase
    .from('activities')
    .select('id, series_id, created_by, series_invite_user_ids')
    .eq('id', input.activityId)
    .single();
  if (aErr) throw aErr;
  const sid = seriesKey(act);

  let guestId = input.guestId;
  if (!guestId) {
    const { data: existing } = await supabase
      .from('activity_guests')
      .select('id')
      .eq('series_id', sid)
      .ilike('name', input.name.trim())
      .maybeSingle();
    guestId = existing?.id;
  }
  if (!guestId) {
    const { data: created, error: cErr } = await supabase
      .from('activity_guests')
      .insert({
        series_id: sid,
        name: input.name.trim(),
        created_by: (await supabase.auth.getUser()).data.user?.id,
      })
      .select('id')
      .single();
    if (cErr) throw cErr;
    guestId = created.id;
  }

  let expenseId: string | null = null;
  if (amount > 0 && feeTreatment === 'split_all') {
    const memberIds = input.memberIds?.length
      ? input.memberIds
      : await defaultSplitMemberIds(input.activityId, sid);
    const userId = (await supabase.auth.getUser()).data.user?.id;
    if (!userId) throw new Error('Not authenticated');
    expenseId = await createExpense({
      seriesId: sid,
      title: `Guest fee: ${input.name.trim()}`,
      amount,
      splitMode: 'equal_all',
      memberIds: memberIds.length ? memberIds : [userId],
      paidBy: userId,
      activityId: input.activityId,
    });
  }

  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Not authenticated');

  const { data: att, error: attErr } = await supabase
    .from('activity_guest_attendances')
    .insert({
      guest_id: guestId,
      activity_id: input.activityId,
      series_id: sid,
      is_free: amount <= 0,
      amount,
      fee_treatment: feeTreatment,
      expense_id: expenseId,
      recorded_by: userId,
    })
    .select('id')
    .single();
  if (attErr) throw attErr;
  return att.id as string;
}

async function defaultSplitMemberIds(activityId: string, seriesId: string): Promise<string[]> {
  const [{ data: act }, { data: joins }, { data: invites }] = await Promise.all([
    supabase
      .from('activities')
      .select('created_by, series_invite_user_ids')
      .eq('id', activityId)
      .single(),
    supabase.from('activity_joins').select('user_id').eq('activity_id', activityId),
    supabase.from('activity_invites').select('user_id').eq('activity_id', activityId),
  ]);
  return Array.from(
    new Set(
      [
        act?.created_by,
        ...(act?.series_invite_user_ids ?? []),
        ...(joins ?? []).map((j: { user_id: string }) => j.user_id),
        ...(invites ?? []).map((i: { user_id: string }) => i.user_id),
      ].filter(Boolean) as string[]
    )
  );
}

export async function removeGuestAttendance(attendanceId: string): Promise<void> {
  const { error } = await supabase.from('activity_guest_attendances').delete().eq('id', attendanceId);
  if (error) throw error;
}

/** Unique people who attended at least once (members + guests), for finance stats. */
export async function fetchSeriesAttendanceStats(seriesId: string): Promise<{
  memberAttendances: { userId: string; count: number }[];
  guestAttendances: { guestId: string; name: string; count: number; totalPaid: number }[];
  uniqueAttendeeCount: number;
}> {
  const { data: acts } = await supabase
    .from('activities')
    .select('id')
    .or(`id.eq.${seriesId},series_id.eq.${seriesId}`);
  const ids = (acts ?? []).map((a: { id: string }) => a.id);

  const memberMap = new Map<string, number>();
  if (ids.length) {
    const { data: joins } = await supabase
      .from('activity_joins')
      .select('user_id, activity_id')
      .in('activity_id', ids);
    for (const j of joins ?? []) {
      memberMap.set(j.user_id, (memberMap.get(j.user_id) ?? 0) + 1);
    }
  }

  const guests = await fetchSeriesGuests(seriesId);
  const guestAttendances = guests
    .filter((g) => g.attendance_count > 0)
    .map((g) => ({
      guestId: g.id,
      name: g.name,
      count: g.attendance_count,
      totalPaid: g.total_paid,
    }));

  return {
    memberAttendances: Array.from(memberMap.entries()).map(([userId, count]) => ({ userId, count })),
    guestAttendances,
    uniqueAttendeeCount: memberMap.size + guestAttendances.length,
  };
}
