import { getT } from '@/i18n/runtime';
import { supabase } from '@/lib/supabase';
import { distanceMeters } from '@/lib/geo';
import { combineDayAndTime, firstOccurrence, isoWeekday, localDayKey, normalizeRules, seriesEndDay, type RecurrenceRule } from '@/lib/recurrence';
import { displayName, type ActivityWithRelations, type Category, type Privacy } from '@/lib/types';
import {
  DEFAULT_SUBCATEGORIES,
  MAIN_CATEGORY_NAMES,
  SUBCATEGORY_PARENT,
  isMainCategoryName,
  resolveCategoryKey,
} from '@/i18n/categories';

export {
  DEFAULT_SUBCATEGORIES,
  MAIN_CATEGORY_NAMES,
  SUBCATEGORY_PARENT,
} from '@/i18n/categories';

const ACTIVITIES_SELECT_BASIC =
  `*, profiles:created_by(id, first_name, last_name, avatar_url), categories(id, name, icon), enterprises(id, name, address, provider_kind, latitude, longitude), activity_joins(count), activity_guest_attendances(count)`;

const ACTIVITIES_SELECT_WITH_PARENT =
  `*, profiles:created_by(id, first_name, last_name, avatar_url), categories(id, name, icon, parent_id), enterprises(id, name, address, provider_kind, latitude, longitude), activity_joins(count), activity_guest_attendances(count)`;

function nestedCount(rel: unknown): number {
  if (Array.isArray(rel) && rel[0] && typeof rel[0] === 'object' && 'count' in (rel[0] as object)) {
    return Number((rel[0] as { count: number }).count) || 0;
  }
  return 0;
}

async function hydrateCategoryParents(activities: ActivityWithRelations[]) {
  const parentIds = Array.from(
    new Set(
      activities
        .map((a) => (a.categories as { parent_id?: string | null } | null)?.parent_id)
        .filter((id): id is string => Boolean(id))
    )
  );
  if (!parentIds.length) return activities;
  const { data: parents } = await supabase.from('categories').select('id, name').in('id', parentIds);
  const map = new Map((parents ?? []).map((p: { id: string; name: string }) => [p.id, p.name]));
  return activities.map((a) => {
    const cat = a.categories as {
      id?: string;
      name?: string;
      icon?: string | null;
      parent_id?: string | null;
      parent?: { id: string; name: string } | null;
    } | null;
    if (!cat?.parent_id) return a;
    const name = map.get(cat.parent_id);
    if (!name) return a;
    return {
      ...a,
      categories: { ...cat, parent: { id: cat.parent_id, name } },
    };
  }) as ActivityWithRelations[];
}

export async function createNotification(
  userId: string,
  type: string,
  message: string,
  data: Record<string, unknown> = {}
) {
  // Prefer RPC so recipient notification prefs are enforced server-side.
  const { error } = await supabase.rpc('notify_user', {
    p_user_id: userId,
    p_type: type,
    p_message: message,
    p_data: data,
  });
  if (error) {
    // Fallback until notify_user.sql is applied in Supabase
    await supabase.from('notifications').insert({
      user_id: userId,
      type,
      message,
      data,
    });
  }
}

export async function profileDisplayName(userId: string): Promise<string> {
  const { data } = await supabase
    .from('profiles')
    .select('first_name, last_name')
    .eq('id', userId)
    .maybeSingle();
  return displayName(data);
}

export async function notifyActivityJoin(
  creatorId: string,
  joinerId: string,
  activityId: string,
  title: string
) {
  if (creatorId === joinerId) return;
  const [{ count }, name] = await Promise.all([
    supabase
      .from('activity_joins')
      .select('*', { count: 'exact', head: true })
      .eq('activity_id', activityId),
    profileDisplayName(joinerId),
  ]);
  await createNotification(
    creatorId,
    'activity_join',
    getT().events.joinedNotice(name, title, count ?? 0),
    { activity_id: activityId }
  );
}

async function attachDeclineCounts(
  activities: ActivityWithRelations[],
  userId: string
): Promise<ActivityWithRelations[]> {
  const activityIds = activities.map((a) => a.id);
  if (!activityIds.length) return activities;
  const { data, error } = await supabase
    .from('activity_declines')
    .select('activity_id, user_id')
    .in('activity_id', activityIds);
  if (error || !data) return activities;
  const counts = new Map<string, number>();
  const mine = new Set<string>();
  for (const row of data as { activity_id: string; user_id: string }[]) {
    counts.set(row.activity_id, (counts.get(row.activity_id) ?? 0) + 1);
    if (row.user_id === userId) mine.add(row.activity_id);
  }
  return activities.map((a) => ({
    ...a,
    decline_count: counts.get(a.id) ?? 0,
    is_declined: mine.has(a.id) && !a.is_joined,
  }));
}

export type EventsInbox = {
  open: ActivityWithRelations[];
  declined: ActivityWithRelations[];
};

type FetchActivitiesOpts = {
  userId: string;
  filter?: 'all' | 'mine' | 'invited' | 'commercial' | 'feed';
  search?: string;
  /** For commercial filter: max distance from origin in km */
  radiusKm?: number;
  origin?: { latitude: number; longitude: number } | null;
  /** Commercial: category id, or null/undefined for all */
  categoryId?: string | null;
  /** Commercial: max price inclusive; 0 = free only; null/undefined = any */
  maxPrice?: number | null;
  /** Split undecided cards from explicit not-going cards. */
  inbox?: boolean;
};

export function fetchActivities(opts: FetchActivitiesOpts & { inbox: true }): Promise<EventsInbox>;
export function fetchActivities(opts: FetchActivitiesOpts): Promise<ActivityWithRelations[]>;
export async function fetchActivities(
  opts: FetchActivitiesOpts
): Promise<ActivityWithRelations[] | EventsInbox> {
  void ensureDueRecurringActivities();

  const nowIso = new Date().toISOString();
  let query = supabase
    .from('activities')
    .select(ACTIVITIES_SELECT_WITH_PARENT)
    .eq('status', 'active')
    .gt('starts_at', nowIso)
    .order('starts_at', { ascending: true });

  if (opts.filter === 'mine') {
    query = query.eq('created_by', opts.userId);
  }

  if (opts.search?.trim()) {
    query = query.ilike('title', `%${opts.search.trim()}%`);
  }

  let { data, error } = await query;
  if (error) {
    // Fallback if parent_id / embed is not available yet
    let fallback = supabase
      .from('activities')
      .select(ACTIVITIES_SELECT_BASIC)
      .eq('status', 'active')
      .gt('starts_at', nowIso)
      .order('starts_at', { ascending: true });
    if (opts.filter === 'mine') fallback = fallback.eq('created_by', opts.userId);
    if (opts.search?.trim()) fallback = fallback.ilike('title', `%${opts.search.trim()}%`);
    const retry = await fallback;
    data = retry.data;
    error = retry.error;
  }
  if (error) throw error;

  let activities = (data ?? []) as ActivityWithRelations[];
  // Past events never appear on Events (one-time or recurring occurrence that already started)
  const nowMs = Date.now();
  activities = activities.filter((a) => new Date(a.starts_at).getTime() > nowMs);
  activities = await hydrateCategoryParents(activities);

  const [{ data: joins }, { data: invites }, { data: friendships }] = await Promise.all([
    supabase.from('activity_joins').select('activity_id').eq('user_id', opts.userId),
    supabase.from('activity_invites').select('activity_id').eq('user_id', opts.userId),
    supabase
      .from('friendships')
      .select('from_user_id, to_user_id')
      .eq('status', 'accepted')
      .or(`from_user_id.eq.${opts.userId},to_user_id.eq.${opts.userId}`),
  ]);

  const joinedIds = new Set((joins ?? []).map((j) => j.activity_id));
  const invitedIds = new Set((invites ?? []).map((i) => i.activity_id));
  const friendIds = new Set(
    Array.from(
      new Set(
        (friendships ?? []).map((f: { from_user_id: string; to_user_id: string }) =>
          f.from_user_id === opts.userId ? f.to_user_id : f.from_user_id
        )
      )
    )
  );

  let result = activities.map((a) => {
    const is_invited = invitedIds.has(a.id);
    const is_mine = a.created_by === opts.userId;
    const is_from_friend = friendIds.has(a.created_by) && !is_mine;
    // Visible via FoF / friends privacy (RLS already filtered); show under "For you"
    const is_open_to_you =
      !is_mine &&
      (a.privacy === 'friends_of_friends' || (a.privacy === 'friends' && is_from_friend));
    const is_commercial =
      Number(a.price) > 0 ||
      Boolean(a.enterprise_id) ||
      (a.enterprises as { provider_kind?: string } | null | undefined)?.provider_kind === 'tobump_booking' ||
      (a.enterprises as { provider_kind?: string } | null | undefined)?.provider_kind === 'official';

    let distance_m: number | null = null;
    if (
      opts.origin &&
      a.enterprises?.latitude != null &&
      a.enterprises?.longitude != null
    ) {
      distance_m = distanceMeters(opts.origin, {
        latitude: a.enterprises.latitude,
        longitude: a.enterprises.longitude,
      });
    }

    return {
      ...a,
      join_count:
        nestedCount((a as { activity_joins?: unknown }).activity_joins) +
        nestedCount((a as { activity_guest_attendances?: unknown }).activity_guest_attendances),
      decline_count: 0,
      is_joined: joinedIds.has(a.id),
      is_declined: false,
      is_invited,
      is_from_friend,
      is_open_to_you,
      is_commercial,
      distance_m,
      // 0 = personal feed (invited / FoF / mine / joined), then commercial, then other
      sort_group: is_invited || is_open_to_you || is_mine || joinedIds.has(a.id) ? 0 : is_commercial ? 1 : 2,
    };
  });

  if (opts.filter === 'feed' || opts.filter === 'all' || !opts.filter) {
    result = result.filter(
      (a) =>
        !a.is_joined &&
        (a.created_by === opts.userId || a.is_invited || Boolean(a.is_open_to_you))
    );
  } else if (opts.filter === 'invited') {
    result = result.filter((a) => a.is_invited || Boolean(a.is_open_to_you));
  } else if (opts.filter === 'mine') {
    result = result.filter((a) => a.created_by === opts.userId);
  } else if (opts.filter === 'commercial') {
    result = result.filter((a) => a.is_commercial && a.created_by !== opts.userId && !a.is_invited);

    if (opts.categoryId) {
      // Main category only: include events whose subcategory belongs under this main
      const { data: children } = await supabase
        .from('categories')
        .select('id')
        .eq('parent_id', opts.categoryId);
      const allowed = new Set<string>([
        opts.categoryId,
        ...((children ?? []) as { id: string }[]).map((c) => c.id),
      ]);
      // Fallback if parent_id column missing: map English subcategory names under this main
      if (allowed.size <= 1) {
        const { data: mainRow } = await supabase
          .from('categories')
          .select('name')
          .eq('id', opts.categoryId)
          .maybeSingle();
        const mainName = (mainRow as { name?: string } | null)?.name;
        if (mainName) {
          const subNames = Object.entries(SUBCATEGORY_PARENT)
            .filter(([, parent]) => parent.toLowerCase() === mainName.toLowerCase())
            .map(([sub]) => sub);
          if (subNames.length) {
            const { data: subs } = await supabase.from('categories').select('id, name').in('name', subNames);
            for (const s of (subs ?? []) as { id: string }[]) allowed.add(s.id);
          }
        }
      }
      result = result.filter((a) => Boolean(a.category_id && allowed.has(a.category_id)));
    }

    if (opts.maxPrice != null) {
      if (opts.maxPrice === 0) {
        result = result.filter((a) => Number(a.price ?? 0) <= 0);
      } else {
        result = result.filter((a) => Number(a.price ?? 0) <= opts.maxPrice!);
      }
    }

    const radiusKm = opts.radiusKm ?? 30;
    const maxM = radiusKm * 1000;
    if (opts.origin) {
      result = result.filter((a) => a.distance_m != null && a.distance_m <= maxM);
      result = hideFullEventsExceptInvolved(result, opts.userId);
      result.sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0));
      return attachDeclineCounts(oneActivityPerSeries(result), opts.userId);
    }
  }

  if (opts.inbox) {
    const marked = await attachDeclineCounts(result, opts.userId);
    // Drop a declined date before picking the series card, so the next date still asks.
    const open = oneActivityPerSeries(
      hideFullEventsExceptInvolved(
        marked.filter((a) => !a.is_declined),
        opts.userId
      )
    );
    open.sort((a, b) => {
      if (a.sort_group !== b.sort_group) return (a.sort_group ?? 0) - (b.sort_group ?? 0);
      return new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
    });
    const declined = marked
      .filter((a) => a.is_declined)
      .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
    return { open, declined };
  }

  // Full events drop out of Events (still visible to organizer / already joined)
  result = hideFullEventsExceptInvolved(result, opts.userId);

  // Personal feed first; within feed sort by start time
  result.sort((a, b) => {
    if (a.sort_group !== b.sort_group) return a.sort_group! - b.sort_group!;
    return new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
  });

  return attachDeclineCounts(oneActivityPerSeries(result), opts.userId);
}

function hideFullEventsExceptInvolved(
  activities: ActivityWithRelations[],
  userId: string
): ActivityWithRelations[] {
  return activities.filter((a) => {
    if (a.max_participants == null) return true;
    const full = (a.join_count ?? 0) >= a.max_participants;
    if (!full) return true;
    return Boolean(a.is_joined) || a.created_by === userId;
  });
}

/** Events feed shows one card per series (soonest upcoming). */
function oneActivityPerSeries(activities: ActivityWithRelations[]): ActivityWithRelations[] {
  const bySeries = new Map<string, ActivityWithRelations>();
  for (const a of activities) {
    const key = a.series_id || a.id;
    const prev = bySeries.get(key);
    if (!prev) {
      bySeries.set(key, a);
      continue;
    }
    if (new Date(a.starts_at).getTime() < new Date(prev.starts_at).getTime()) {
      bySeries.set(key, a);
    }
  }
  return Array.from(bySeries.values());
}

/** Find subcategory id by English (or alias / localized) name. */
export async function findCategoryId(name: string): Promise<string | null> {
  const key = resolveCategoryKey(name) ?? (isMainCategoryName(name) ? null : name.trim() || null);
  if (!key || isMainCategoryName(key)) return null;

  const { data, error } = await supabase.from('categories').select('id, parent_id').ilike('name', key);

  if (error) {
    const flat = await supabase.from('categories').select('id').ilike('name', key).limit(1);
    return flat.data?.[0]?.id ?? null;
  }

  const rows = data ?? [];
  const withParent = rows.find((r) => r.parent_id);
  if (withParent?.id) return withParent.id;

  const flat = rows.find((r) => !r.parent_id) ?? rows[0];
  return flat?.id ?? null;
}

/** Ensure top-level + subcategory seed exists (idempotent). Prefer running category_hierarchy.sql. */
let categoriesSeedPromise: Promise<void> | null = null;

export async function ensureDefaultCategories() {
  if (categoriesSeedPromise) return categoriesSeedPromise;
  categoriesSeedPromise = (async () => {
  try {
    const probe = await supabase.from('categories').select('id, parent_id').limit(1);
    const hasParentCol = !probe.error;

    if (!hasParentCol) {
      for (const name of DEFAULT_SUBCATEGORIES) {
        const existing = await supabase.from('categories').select('id').ilike('name', name).limit(1);
        if (!existing.data?.[0]?.id) await supabase.from('categories').insert({ name });
      }
      return;
    }

    const mains: { name: (typeof MAIN_CATEGORY_NAMES)[number]; icon: string }[] = [
      { name: 'Sport', icon: 'sport' },
      { name: 'Culture', icon: 'culture' },
      { name: 'Social', icon: 'social' },
      { name: 'Outdoor', icon: 'outdoor' },
      { name: 'Food & Drink', icon: 'food' },
      { name: 'Education', icon: 'education' },
    ];

    const parentIds = new Map<string, string>();
    // Parallel lookups for main categories
    const mainRows = await Promise.all(
      mains.map(async (m) => {
        const { data } = await supabase
          .from('categories')
          .select('id')
          .ilike('name', m.name)
          .is('parent_id', null)
          .limit(1);
        let id = data?.[0]?.id as string | undefined;
        if (!id) {
          const inserted = await supabase
            .from('categories')
            .insert({ name: m.name, icon: m.icon, parent_id: null })
            .select('id')
            .limit(1);
          id = inserted.data?.[0]?.id;
        }
        return { name: m.name, id };
      })
    );
    for (const row of mainRows) {
      if (row.id) parentIds.set(row.name, row.id);
    }

    await Promise.all(
      Object.entries(SUBCATEGORY_PARENT).map(async ([name, parentName]) => {
        const parentId = parentIds.get(parentName);
        if (!parentId) return;
        const { data } = await supabase.from('categories').select('id, parent_id').ilike('name', name).limit(1);
        const row = data?.[0] as { id: string; parent_id: string | null } | undefined;
        if (!row?.id) {
          await supabase.from('categories').insert({ name, parent_id: parentId });
        } else if (!row.parent_id) {
          await supabase.from('categories').update({ parent_id: parentId }).eq('id', row.id);
        }
      })
    );
  } catch {
    // ignore seed errors — allow retry on next call
    categoriesSeedPromise = null;
  }
  })();
  return categoriesSeedPromise;
}

/** Top-level categories only (Sport, Culture…). Never returns subcategories. */
export async function fetchMainCategories(): Promise<Category[]> {
  const mainSet = new Set(MAIN_CATEGORY_NAMES.map((n) => n.toLowerCase()));

  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .is('parent_id', null)
    .order('name');

  let rows = (!error ? (data as Category[]) : null) ?? null;
  if (!rows) {
    const flat = await supabase.from('categories').select('*').order('name');
    rows = (flat.data as Category[]) ?? [];
  }

  return rows.filter((c) => mainSet.has(c.name.trim().toLowerCase()));
}

export async function fetchSubcategories(): Promise<Category[]> {
  const mainSet = new Set(MAIN_CATEGORY_NAMES.map((n) => n.toLowerCase()));
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .not('parent_id', 'is', null)
    .order('name');
  if (!error) {
    return ((data as Category[]) ?? []).filter((c) => !mainSet.has(c.name.trim().toLowerCase()));
  }
  const flat = await supabase.from('categories').select('*').order('name');
  return ((flat.data as Category[]) ?? []).filter((c) => !mainSet.has(c.name.trim().toLowerCase()));
}

export async function joinActivity(activityId: string, userId: string, creatorId: string, title: string) {
  const { error } = await supabase.rpc('join_activity_safe', { p_activity_id: activityId });
  if (error) {
    const msg = error.message ?? '';
    if (/full/i.test(msg)) {
      throw new Error('Event is full');
    }
    // Fallback if RPC not migrated yet
    if (/function|does not exist|schema cache/i.test(msg)) {
      const { data: activity } = await supabase
        .from('activities')
        .select('max_participants')
        .eq('id', activityId)
        .single();

      if (activity?.max_participants) {
        const { count } = await supabase
          .from('activity_joins')
          .select('*', { count: 'exact', head: true })
          .eq('activity_id', activityId);
        if ((count ?? 0) >= activity.max_participants) {
          throw new Error('Event is full');
        }
      }

      const { error: insertErr } = await supabase.from('activity_joins').insert({
        activity_id: activityId,
        user_id: userId,
      });
      if (insertErr) {
        if (/full/i.test(insertErr.message)) throw new Error('Event is full');
        if (insertErr.code === '23505') {
          // already joined
        } else {
          throw insertErr;
        }
      }
    } else {
      throw error;
    }
  }

  if (creatorId !== userId) {
    await notifyActivityJoin(creatorId, userId, activityId, title);
  }

  await clearActivityDecline(activityId, userId);

  // Create per-person fee on first attendance (if eligible)
  try {
    const { fetchSeriesFinanceSettings, seriesKey, syncAttendeeFundingFees } = await import(
      '@/lib/finance'
    );
    const { data: act } = await supabase
      .from('activities')
      .select('id, series_id, created_by, finance_enabled, title, starts_at')
      .eq('id', activityId)
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
}

function declinesTableMissing(message: string) {
  return /activity_declines|schema cache|does not exist|could not find the table/i.test(message);
}

/** Drop an explicit "can't come" so the person is back to no answer, or can join. */
export async function clearActivityDecline(activityId: string, userId: string) {
  const { error } = await supabase
    .from('activity_declines')
    .delete()
    .eq('activity_id', activityId)
    .eq('user_id', userId);
  if (error && !declinesTableMissing(error.message ?? '')) throw error;
}

/** This occurrence only. Does not change other dates in the series. */
export async function declineActivity(activityId: string, userId: string) {
  const { error } = await supabase.from('activity_declines').upsert(
    { activity_id: activityId, user_id: userId },
    { onConflict: 'activity_id,user_id' }
  );
  if (error) {
    if (declinesTableMissing(error.message ?? '')) throw new Error('DECLINES_DB');
    throw error;
  }
}

export async function leaveActivity(activityId: string, userId: string) {
  // This date only. A failed "not going" write must not keep the signup.
  let declineError: unknown = null;
  try {
    await declineActivity(activityId, userId);
  } catch (e) {
    declineError = e;
  }

  try {
    const { clearAttendanceFundingFee } = await import('@/lib/finance');
    await clearAttendanceFundingFee({ activityId, userId });
  } catch {
    /* finance RPC / tables may be missing */
  }

  const { error } = await supabase
    .from('activity_joins')
    .delete()
    .eq('activity_id', activityId)
    .eq('user_id', userId);
  if (error) throw error;
  if (declineError) throw declineError;
}

export type ActivityInput = {
  title: string;
  description?: string;
  starts_at: string;
  ends_at?: string | null;
  price?: number | null;
  max_participants?: number | null;
  min_participants?: number | null;
  privacy: Privacy;
  category_id?: string | null;
  enterprise_id?: string | null;
  venue_text?: string | null;
  venue_latitude?: number | null;
  venue_longitude?: number | null;
  group_id?: string | null;
  chat_enabled?: boolean;
  invite_user_ids?: string[];
  /** Friends granted edit rights (managed by creator only) */
  editor_user_ids?: string[];
  is_recurring?: boolean;
  /** Enable Tricount-style shared expenses for this event / series */
  finance_enabled?: boolean;
  /** Show the start-time forecast on this event */
  show_weather?: boolean;
  recurrence_rules?: RecurrenceRule[];
  /** Last calendar day for the series (YYYY-MM-DD), required when weekly */
  recurrence_until?: string | null;
  /** Picked calendar days (YYYY-MM-DD) for a dated series */
  recurrence_dates?: string[];
  duration_minutes?: number | null;
};

export type DeleteActivityMode = 'occurrence' | 'series';

export async function userCanEditActivity(activityId: string, userId: string) {
  const { data: act } = await supabase
    .from('activities')
    .select('created_by')
    .eq('id', activityId)
    .maybeSingle();
  if (!act) return { canEdit: false, isCreator: false };
  if (act.created_by === userId) return { canEdit: true, isCreator: true };
  const { data: ed } = await supabase
    .from('activity_editors')
    .select('user_id')
    .eq('activity_id', activityId)
    .eq('user_id', userId)
    .maybeSingle();
  return { canEdit: Boolean(ed), isCreator: false };
}

let dueRecurringOnce: Promise<void> | null = null;

/** Open the next series date in the background, at most once per app session. */
export function ensureDueRecurringActivities(): Promise<void> {
  if (!dueRecurringOnce) {
    dueRecurringOnce = processDueRecurringActivities().catch(() => {
      dueRecurringOnce = null;
    });
  }
  return dueRecurringOnce;
}

export async function processDueRecurringActivities() {
  const now = new Date().toISOString();
  const { error } = await supabase.rpc('process_due_recurring_activities');

  if (error) {
    const { data: dueRecurring } = await supabase
      .from('activities')
      .select('id')
      .eq('status', 'active')
      .eq('is_recurring', true)
      .lte('starts_at', now);
    for (const row of dueRecurring ?? []) {
      await supabase.rpc('open_next_recurring_activity', { p_activity_id: row.id });
    }
    await supabase
      .from('activities')
      .update({ status: 'completed', updated_at: now })
      .eq('status', 'active')
      .eq('is_recurring', false)
      .lte('starts_at', now);
  }
}

/** Delete one occurrence (series continues) or the whole series / single event. */
export async function deleteActivity(activityId: string, mode: DeleteActivityMode = 'series') {
  if (mode === 'occurrence') {
    const { data: act, error: loadError } = await supabase
      .from('activities')
      .select('id, series_id, starts_at, recurrence_dates')
      .eq('id', activityId)
      .maybeSingle();
    if (loadError) throw loadError;
    if (!act) return;

    const sid = (act.series_id as string | null) ?? act.id;
    const day = localDayKey(new Date(act.starts_at as string));

    const { error: skipDayErr } = await supabase.rpc('skip_series_day', {
      p_series_id: sid,
      p_day: day,
    });
    if (skipDayErr) {
      const { error: ins } = await supabase.from('series_skipped_dates').insert({
        series_id: sid,
        day,
      });
      if (ins && ins.code !== '23505') {
        const { error: skipError } = await supabase.rpc('skip_recurring_occurrence', {
          p_activity_id: activityId,
        });
        if (skipError) {
          const { error: delError } = await supabase.from('activities').delete().eq('id', activityId);
          if (delError) throw delError;
        }
      } else {
        await supabase
          .from('activities')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('id', activityId)
          .eq('status', 'active');
        await supabase.rpc('skip_recurring_occurrence', { p_activity_id: activityId });
      }
    }

    const dates = ((act.recurrence_dates as string[] | null) ?? [])
      .map((d) => String(d).slice(0, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (dates.includes(day)) {
      const nextDates = dates.filter((d) => d !== day);
      await supabase.from('activities').update({ recurrence_dates: nextDates }).eq('id', sid);
      await supabase.from('activities').update({ recurrence_dates: nextDates }).eq('series_id', sid);
    }

    await assertOccurrenceRemoved(activityId);
    return;
  }

  const { error: rpcError } = await supabase.rpc('cancel_activity_series', {
    p_activity_id: activityId,
  });
  if (!rpcError) {
    await assertActivityGone(activityId);
    return;
  }

  // Fallback if RPC is missing / outdated in Supabase
  const { data: act, error: loadError } = await supabase
    .from('activities')
    .select('id, series_id, is_recurring, created_by')
    .eq('id', activityId)
    .maybeSingle();
  if (loadError) throw loadError;
  if (!act) return;

  const seriesId = act.series_id ?? act.id;

  if (act.is_recurring) {
    const { error: stopError } = await supabase
      .from('activities')
      .update({
        is_recurring: false,
        status: 'cancelled',
        recurrence_rules: [],
        recurrence_weekdays: [],
      })
      .or(`id.eq.${seriesId},series_id.eq.${seriesId},id.eq.${activityId}`);
    if (stopError) throw stopError;

    const { error: delError } = await supabase
      .from('activities')
      .delete()
      .or(`id.eq.${seriesId},series_id.eq.${seriesId},id.eq.${activityId}`);
    if (delError) throw delError;
    await assertActivityGone(activityId);
    return;
  }

  const { error: delError } = await supabase.from('activities').delete().eq('id', activityId);
  if (delError) throw delError;
  await assertActivityGone(activityId);
}

async function assertActivityGone(activityId: string) {
  const { data, error } = await supabase.from('activities').select('id').eq('id', activityId).maybeSingle();
  if (error) throw error;
  if (data) {
    throw new Error('Could not delete the event. Try again.');
  }
}

async function assertOccurrenceRemoved(activityId: string) {
  const { data, error } = await supabase
    .from('activities')
    .select('id, status')
    .eq('id', activityId)
    .maybeSingle();
  if (error) throw error;
  if (data && (data as { status?: string }).status === 'active') {
    throw new Error('Could not delete the event. Try again.');
  }
}

async function syncSeriesShowWeather(seriesId: string, enabled: boolean) {
  const patch = { show_weather: enabled };
  const byId = await supabase.from('activities').update(patch).eq('id', seriesId);
  if (byId.error && /show_weather/i.test(byId.error.message ?? '')) return;
  if (byId.error) throw byId.error;
  const bySeries = await supabase.from('activities').update(patch).eq('series_id', seriesId);
  if (bySeries.error && /show_weather/i.test(bySeries.error.message ?? '')) return;
  if (bySeries.error) throw bySeries.error;
}

export async function saveActivity(userId: string, input: ActivityInput, activityId?: string) {
  if (input.privacy === 'group' && !input.group_id) {
    throw new Error('Select a group.');
  }
  if (input.privacy === 'invite' && !(input.invite_user_ids?.length)) {
    throw new Error('Select at least one friend to invite.');
  }
  const dateDays = Array.from(new Set((input.recurrence_dates ?? []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))).sort();
  const weeklyRules = normalizeRules(input.recurrence_rules ?? []);
  const isWeekly = Boolean(input.is_recurring) && weeklyRules.length > 0;
  const isDateSeries = dateDays.length >= 2 && !isWeekly;
  const rules = isWeekly ? weeklyRules : [];
  if (input.is_recurring && !isDateSeries && rules.length === 0) {
    throw new Error('Select at least one weekday for recurrence.');
  }
  if (isWeekly && rules.some((r) => !r.duration_minutes || r.duration_minutes < 15)) {
    throw new Error('Set a duration for each day (at least 15 min).');
  }
  if (input.is_recurring && !isDateSeries && !isWeekly) {
    throw new Error('Select at least two dates, or pick weekdays.');
  }
  if (isWeekly) {
    const until = input.recurrence_until?.trim();
    if (!until || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      throw new Error('Set an end date for the recurring series.');
    }
    if (input.starts_at) {
      const startDay = input.starts_at.slice(0, 10);
      if (until < startDay) {
        throw new Error('Series end date must be on or after the first start date.');
      }
    }
  }

  let inviteIds = input.invite_user_ids ?? [];

  if (input.privacy === 'friends') {
    const { data: fr } = await supabase
      .from('friendships')
      .select('from_user_id, to_user_id')
      .eq('status', 'accepted')
      .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`);
    inviteIds = Array.from(
      new Set(
        (fr ?? []).map((f: { from_user_id: string; to_user_id: string }) =>
          f.from_user_id === userId ? f.to_user_id : f.from_user_id
        )
      )
    );
  }

  if (input.privacy === 'group' && input.group_id) {
    const { data: members } = await supabase
      .from('friend_group_members')
      .select('user_id')
      .eq('group_id', input.group_id);
    inviteIds = (members ?? []).map((m: { user_id: string }) => m.user_id).filter((uid) => uid !== userId);
  }

  // FoF: seed with invited friends and/or a group; expands to friends of non-organizer joiners
  if (input.privacy === 'friends_of_friends') {
    const seeded = Array.from(new Set(input.invite_user_ids ?? [])).filter((uid) => uid !== userId);
    if (input.group_id) {
      const { data: members } = await supabase
        .from('friend_group_members')
        .select('user_id')
        .eq('group_id', input.group_id);
      const fromGroup = (members ?? [])
        .map((m: { user_id: string }) => m.user_id)
        .filter((uid) => uid !== userId);
      inviteIds = Array.from(new Set([...seeded, ...fromGroup]));
    } else {
      inviteIds = seeded;
    }
    if (!inviteIds.length) {
      throw new Error('Invite at least one friend or select a group.');
    }
  }

  const needed = input.min_participants;
  if (needed != null) {
    const others = new Set(inviteIds.filter((uid) => uid !== userId));
    if (others.size + 1 < needed) {
      throw new Error(getT().form.needMorePeople(needed - (others.size + 1)));
    }
  }

  const minCap = input.min_participants;
  if (minCap != null && (!Number.isFinite(minCap) || minCap < 1 || !Number.isInteger(minCap))) {
    throw new Error('Minimum capacity must be a positive whole number.');
  }
  const capacity = input.max_participants;
  if (capacity != null && (!Number.isFinite(capacity) || capacity < 1 || !Number.isInteger(capacity))) {
    throw new Error('Maximum capacity must be a positive whole number.');
  }
  if (minCap != null && capacity != null && minCap > capacity) {
    throw new Error('Minimum capacity cannot be greater than maximum.');
  }

  const weekdays = rules.map((r) => r.weekday);
  const weeklyExtraDates = isWeekly
    ? dateDays.filter((d) => {
        const dt = new Date(`${d}T12:00:00`);
        if (Number.isNaN(dt.getTime())) return false;
        return !rules.some((r) => r.weekday === isoWeekday(dt));
      })
    : [];

  let startsAt = input.starts_at;
  let endsAt = input.ends_at || null;
  let durationMinutes: number | null = null;
  const weeklyUntil = isWeekly ? seriesEndDay(input.recurrence_until, dateDays) : null;

  if (isDateSeries) {
    const seed = startsAt ? new Date(startsAt) : new Date();
    durationMinutes = Math.max(15, Math.round(input.duration_minutes || durationMinutes || 90));
    if (activityId && startsAt) {
      endsAt = new Date(seed.getTime() + durationMinutes * 60_000).toISOString();
    } else {
      const first = combineDayAndTime(dateDays[0], seed.getHours(), seed.getMinutes());
      startsAt = first.toISOString();
      endsAt = new Date(first.getTime() + durationMinutes * 60_000).toISOString();
    }
  } else if (isWeekly && startsAt) {
    const from = new Date(startsAt);
    const until = weeklyUntil ? new Date(`${weeklyUntil}T23:59:59`) : null;
    const first = firstOccurrence(from, rules, { now: from, until });
    if (first) startsAt = first.toISOString();
    const start = new Date(startsAt);
    const iso = isoWeekday(start);
    const rule = rules.find((r) => r.weekday === iso) ?? rules[0];
    durationMinutes = rule.duration_minutes;
    endsAt = new Date(start.getTime() + durationMinutes * 60_000).toISOString();
  } else if (input.duration_minutes && input.duration_minutes >= 15 && startsAt) {
    durationMinutes = Math.max(15, Math.round(input.duration_minutes));
    endsAt = new Date(new Date(startsAt).getTime() + durationMinutes * 60_000).toISOString();
  }

  const payload: Record<string, unknown> = {
    title: input.title.trim(),
    description: null,
    starts_at: startsAt,
    ends_at: endsAt,
    price: input.finance_enabled ? Number(input.price) || 0 : null,
    min_participants: input.min_participants ?? null,
    max_participants: input.max_participants ?? null,
    privacy: input.privacy,
    category_id: input.category_id || null,
    enterprise_id: input.enterprise_id || null,
    venue_text: input.enterprise_id ? null : input.venue_text?.trim() || null,
    venue_latitude: input.enterprise_id ? null : input.venue_latitude ?? null,
    venue_longitude: input.enterprise_id ? null : input.venue_longitude ?? null,
    group_id: input.privacy === 'group' ? input.group_id || null : null,
    chat_enabled: input.chat_enabled ?? true,
    created_by: userId,
    is_recurring: Boolean(input.is_recurring) || isDateSeries,
    finance_enabled: Boolean(input.finance_enabled),
    show_weather: Boolean(input.show_weather),
    recurrence_weekdays: weekdays,
    recurrence_rules: rules,
    recurrence_until: isWeekly ? weeklyUntil : isDateSeries ? dateDays[dateDays.length - 1] : null,
    recurrence_dates: isDateSeries ? dateDays : isWeekly ? weeklyExtraDates : [],
    duration_minutes: durationMinutes,
    updated_at: new Date().toISOString(),
  };

  let id = activityId;
  if (activityId) {
    const access = await userCanEditActivity(activityId, userId);
    if (!access.canEdit) {
      throw new Error('You do not have permission to edit this event.');
    }
    const { data: existing, error: loadError } = await supabase
      .from('activities')
      .select('created_by, series_id, is_recurring, starts_at, recurrence_dates, privacy')
      .eq('id', activityId)
      .maybeSingle();
    if (loadError) throw loadError;
    if (!existing) throw new Error(getT().events.notFound);

    // created_by must stay the original creator
    delete payload.created_by;

    const keepFof =
      (existing as { privacy?: Privacy }).privacy === 'friends_of_friends' &&
      input.privacy !== 'friends_of_friends';
    if (keepFof) payload.privacy = 'friends_of_friends';

    const seriesGroupId = input.privacy === 'group' ? input.group_id || null : null;
    if (existing.is_recurring || input.is_recurring) {
      payload.series_privacy = input.privacy;
      payload.series_group_id = seriesGroupId;
      payload.series_invite_user_ids = inviteIds;
    }

    const { error } = await supabase.from('activities').update(payload).eq('id', activityId);
    if (error && /recurrence_dates|show_weather/i.test(error.message ?? '')) {
      const fallback = { ...payload };
      if (/recurrence_dates/i.test(error.message ?? '')) delete fallback.recurrence_dates;
      if (/show_weather/i.test(error.message ?? '')) delete fallback.show_weather;
      const retry = await supabase.from('activities').update(fallback).eq('id', activityId);
      if (retry.error && /recurrence_dates|show_weather/i.test(retry.error.message ?? '')) {
        delete fallback.recurrence_dates;
        delete fallback.show_weather;
        const again = await supabase.from('activities').update(fallback).eq('id', activityId);
        if (again.error) throw again.error;
      } else if (retry.error) {
        throw retry.error;
      }
    } else if (error) {
      throw error;
    }

    if (existing.is_recurring || isDateSeries || isWeekly) {
      await syncSeriesShowWeather(existing.series_id ?? activityId, Boolean(input.show_weather));
    }

    if (isDateSeries || isWeekly) {
      const sid = existing.series_id ?? activityId;
      const storedDates = isDateSeries ? dateDays : weeklyExtraDates;
      const seriesPatch = {
        recurrence_dates: storedDates,
        recurrence_until: payload.recurrence_until,
      };
      await supabase.from('activities').update(seriesPatch).eq('id', sid);
      await supabase.from('activities').update(seriesPatch).eq('series_id', sid);
      for (const day of dateDays) {
        await supabase.from('series_skipped_dates').delete().eq('series_id', sid).eq('day', day);
      }
    }

    await supabase.from('activity_invites').delete().eq('activity_id', activityId);

    // Invite/privacy template applies to this + all upcoming occurrences in the series
    if (existing.is_recurring) {
      const sid = existing.series_id ?? activityId;
      const fromStarts = existing.starts_at as string;
      await supabase
        .from('activities')
        .update({
          series_privacy: input.privacy,
          series_group_id: seriesGroupId,
          series_invite_user_ids: inviteIds,
          privacy: input.privacy,
          group_id: seriesGroupId,
          updated_at: new Date().toISOString(),
        })
        .eq('series_id', sid)
        .eq('status', 'active')
        .gte('starts_at', fromStarts)
        .neq('id', activityId);

      const { data: futureActs } = await supabase
        .from('activities')
        .select('id')
        .eq('series_id', sid)
        .eq('status', 'active')
        .gte('starts_at', fromStarts);
      const futureIds = (futureActs ?? [])
        .map((a: { id: string }) => a.id)
        .filter((fid: string) => fid !== activityId);

      for (const fid of futureIds) {
        await supabase.from('activity_invites').delete().eq('activity_id', fid);
        if (inviteIds.length) {
          const rows = Array.from(new Set(inviteIds)).map((uid) => ({
            activity_id: fid,
            user_id: uid,
            invited_by: userId,
          }));
          await supabase.from('activity_invites').upsert(rows, { onConflict: 'activity_id,user_id' });
        }
      }
    }

    if (access.isCreator) {
      await syncActivityEditors(activityId, userId, input.editor_user_ids ?? [], input.title);
    }
  } else {
    const newId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : undefined;
    if (newId) {
      payload.id = newId;
      payload.series_id = newId;
    }
    if (input.is_recurring || isDateSeries) {
      payload.series_privacy = input.privacy;
      payload.series_group_id = input.privacy === 'group' ? input.group_id || null : null;
      payload.series_invite_user_ids = inviteIds;
    } else {
      payload.series_privacy = null;
      payload.series_group_id = null;
      payload.series_invite_user_ids = [];
    }
    let { data, error } = await supabase.from('activities').insert(payload).select('id').single();
    if (error && /recurrence_dates|show_weather/i.test(error.message ?? '')) {
      const fallback = { ...payload };
      if (/recurrence_dates/i.test(error.message ?? '')) delete fallback.recurrence_dates;
      if (/show_weather/i.test(error.message ?? '')) delete fallback.show_weather;
      const retry = await supabase.from('activities').insert(fallback).select('id').single();
      data = retry.data;
      error = retry.error;
      if (error && /recurrence_dates|show_weather/i.test(error.message ?? '')) {
        delete fallback.recurrence_dates;
        delete fallback.show_weather;
        const again = await supabase.from('activities').insert(fallback).select('id').single();
        data = again.data;
        error = again.error;
      }
    }
    if (error || !data?.id) throw error ?? new Error('Could not create the event.');
    id = data.id;
    if (input.is_recurring || isDateSeries) {
      await syncSeriesShowWeather(id, Boolean(input.show_weather));
    }
    if (!newId) {
      await supabase.from('activities').update({ series_id: id }).eq('id', id);
    }
    await syncActivityEditors(id!, userId, input.editor_user_ids ?? [], input.title);
  }

  if (inviteIds.length && id) {
    const unique = Array.from(new Set(inviteIds));
    const rows = unique.map((uid) => ({
      activity_id: id!,
      user_id: uid,
      invited_by: userId,
    }));
    const { error: inviteError } = await supabase
      .from('activity_invites')
      .upsert(rows, { onConflict: 'activity_id,user_id' });
    if (inviteError) throw inviteError;
    const inviter = await profileDisplayName(userId);
    void Promise.all(
      unique.map((uid) =>
        createNotification(uid, 'invite', getT().events.inviteNotice(inviter, input.title), {
          activity_id: id,
        })
      )
    );
  }

  return id!;
}

async function syncActivityEditors(
  activityId: string,
  grantedBy: string,
  editorIds: string[],
  title: string
) {
  const unique = Array.from(new Set(editorIds.filter((uid) => uid && uid !== grantedBy)));
  const { data: prev } = await supabase
    .from('activity_editors')
    .select('user_id')
    .eq('activity_id', activityId);
  const prevIds = new Set((prev ?? []).map((r: { user_id: string }) => r.user_id));

  await supabase.from('activity_editors').delete().eq('activity_id', activityId);
  if (!unique.length) return;

  const rows = unique.map((uid) => ({
    activity_id: activityId,
    user_id: uid,
    granted_by: grantedBy,
  }));
  const { error } = await supabase.from('activity_editors').upsert(rows, {
    onConflict: 'activity_id,user_id',
  });
  if (error) throw error;

  const newcomers = unique.filter((uid) => !prevIds.has(uid));
  if (newcomers.length) {
    const granter = await profileDisplayName(grantedBy);
    void Promise.all(
      newcomers.map((uid) =>
        createNotification(uid, 'editor', getT().events.editorNotice(granter, title), {
          activity_id: activityId,
        })
      )
    );
  }
}
