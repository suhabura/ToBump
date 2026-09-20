import { createNotification, joinActivity } from '@/lib/api';
import { seriesKey } from '@/lib/finance';
import { supabase } from '@/lib/supabase';
import type { ActivityWithRelations } from '@/lib/types';

export async function fetchSeriesFollows(userId: string): Promise<Set<string>> {
  const { data, error } = await supabase.from('series_follows').select('series_id').eq('user_id', userId);
  if (error) return new Set();
  return new Set((data ?? []).map((r: { series_id: string }) => r.series_id));
}

export async function fetchSkippedDays(seriesIds: string[]): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  if (!seriesIds.length) return map;
  const { data, error } = await supabase
    .from('series_skipped_dates')
    .select('series_id, day')
    .in('series_id', seriesIds);
  if (error) return map;
  for (const row of data ?? []) {
    const sid = (row as { series_id: string }).series_id;
    const day = String((row as { day: string }).day).slice(0, 10);
    const set = map.get(sid) ?? new Set<string>();
    set.add(day);
    map.set(sid, set);
  }
  return map;
}

export async function setSeriesFollow(seriesId: string, follow: boolean) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.id) throw new Error('Not signed in');
  if (follow) {
    const { error } = await supabase.from('series_follows').upsert(
      { series_id: seriesId, user_id: user.id },
      { onConflict: 'series_id,user_id' }
    );
    if (error) throw error;
    return;
  }
  const { error } = await supabase
    .from('series_follows')
    .delete()
    .eq('series_id', seriesId)
    .eq('user_id', user.id);
  if (error) throw error;
}

export async function skipSeriesDay(seriesId: string, day: string) {
  const { error } = await supabase.rpc('skip_series_day', { p_series_id: seriesId, p_day: day });
  if (error) {
    const { error: ins } = await supabase.from('series_skipped_dates').insert({
      series_id: seriesId,
      day,
    });
    if (ins) throw error;
  }
}

export async function unskipSeriesDay(seriesId: string, day: string) {
  const { error } = await supabase.from('series_skipped_dates').delete().eq('series_id', seriesId).eq('day', day);
  if (error) throw error;
}

export async function joinSeriesOccurrence(
  activity: Pick<ActivityWithRelations, 'id' | 'series_id' | 'created_by' | 'title'>,
  startsAt: Date,
  userId: string
): Promise<string> {
  const sid = seriesKey(activity);
  const { data, error } = await supabase.rpc('join_series_occurrence', {
    p_series_id: sid,
    p_starts_at: startsAt.toISOString(),
  });
  if (error) {
    const { data: ensured, error: ensErr } = await supabase.rpc('ensure_series_occurrence', {
      p_series_id: sid,
      p_starts_at: startsAt.toISOString(),
    });
    if (ensErr) throw error;
    const oid = (ensured as string | null) ?? activity.id;
    await joinActivity(oid, userId, activity.created_by, activity.title);
    return oid;
  }
  const oid = (data as string) ?? activity.id;
  if (activity.created_by !== userId) {
    void createNotification(activity.created_by, 'activity_join', `Someone joined: ${activity.title}`, {
      activity_id: oid,
    });
  }
  try {
    const { fetchSeriesFinanceSettings, syncAttendeeFundingFees } = await import('@/lib/finance');
    const { data: act } = await supabase
      .from('activities')
      .select('id, series_id, created_by, finance_enabled, title, starts_at')
      .eq('id', oid)
      .maybeSingle();
    if (act?.finance_enabled) {
      const settings = await fetchSeriesFinanceSettings(seriesKey(act));
      if (settings && Number(settings.amount) > 0) {
        await syncAttendeeFundingFees({
          activity: act,
          settings,
          onlyUserId: userId,
        });
      }
    }
  } catch {
    /* finance tables / settings may be missing */
  }
  return oid;
}

export async function openSeriesOccurrence(
  activity: Pick<ActivityWithRelations, 'id' | 'series_id'>,
  startsAt: Date
): Promise<string> {
  const sid = seriesKey(activity);
  const { data, error } = await supabase.rpc('ensure_series_occurrence', {
    p_series_id: sid,
    p_starts_at: startsAt.toISOString(),
  });
  if (error) throw error;
  return (data as string) ?? activity.id;
}
