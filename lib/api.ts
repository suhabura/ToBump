import { supabase } from '@/lib/supabase';
import { distanceMeters } from '@/lib/geo';
import { normalizeRules, type RecurrenceRule } from '@/lib/recurrence';
import type { ActivityWithRelations, Category, Privacy } from '@/lib/types';
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
  `*, profiles:created_by(id, first_name, last_name, avatar_url), categories(id, name, icon), enterprises(id, name, address, provider_kind, latitude, longitude), activity_joins(count)`;

const ACTIVITIES_SELECT_WITH_PARENT =
  `*, profiles:created_by(id, first_name, last_name, avatar_url), categories(id, name, icon, parent_id), enterprises(id, name, address, provider_kind, latitude, longitude), activity_joins(count)`;

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

export async function fetchActivities(opts: {
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
}): Promise<ActivityWithRelations[]> {
  // Počisti začete dogodke; pri ponavljajočih odpri naslednji termin
  try {
    await processDueRecurringActivities();
  } catch {
    // RPC morda še ni v bazi – ignoriraj
  }

  let query = supabase
    .from('activities')
    .select(ACTIVITIES_SELECT_WITH_PARENT)
    .eq('status', 'active')
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
      .order('starts_at', { ascending: true });
    if (opts.filter === 'mine') fallback = fallback.eq('created_by', opts.userId);
    if (opts.search?.trim()) fallback = fallback.ilike('title', `%${opts.search.trim()}%`);
    const retry = await fallback;
    data = retry.data;
    error = retry.error;
  }
  if (error) throw error;

  let activities = (data ?? []) as ActivityWithRelations[];
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
        Array.isArray(a.activity_joins) && a.activity_joins[0] && 'count' in a.activity_joins[0]
          ? Number((a.activity_joins[0] as { count: number }).count)
          : 0,
      is_joined: joinedIds.has(a.id),
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
        a.is_invited ||
        Boolean(a.is_open_to_you) ||
        a.created_by === opts.userId ||
        Boolean(a.is_joined)
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
      return result;
    }
  }

  // Full events drop out of Events (still visible to organizer / already joined)
  result = hideFullEventsExceptInvolved(result, opts.userId);

  // Personal feed first; within feed sort by start time
  result.sort((a, b) => {
    if (a.sort_group !== b.sort_group) return a.sort_group! - b.sort_group!;
    return new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
  });

  return result;
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

  const { error } = await supabase.from('activity_joins').insert({
    activity_id: activityId,
    user_id: userId,
  });
  if (error) throw error;

  if (creatorId !== userId) {
    await createNotification(creatorId, 'activity_join', `Someone joined: ${title}`, {
      activity_id: activityId,
    });
  }
}

export async function leaveActivity(activityId: string, userId: string) {
  const { error } = await supabase
    .from('activity_joins')
    .delete()
    .eq('activity_id', activityId)
    .eq('user_id', userId);
  if (error) throw error;
}

export type ActivityInput = {
  title: string;
  description?: string;
  starts_at: string;
  ends_at?: string | null;
  price?: number | null;
  max_participants?: number | null;
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
  recurrence_rules?: RecurrenceRule[];
  /** Last calendar day for the series (YYYY-MM-DD), required when recurring */
  recurrence_until?: string | null;
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

export async function processDueRecurringActivities() {
  await supabase.rpc('process_due_recurring_activities');
}

/** Delete one occurrence (series continues) or the whole series / single event. */
export async function deleteActivity(activityId: string, mode: DeleteActivityMode = 'series') {
  if (mode === 'occurrence') {
    const { error: skipError } = await supabase.rpc('skip_recurring_occurrence', {
      p_activity_id: activityId,
    });
    if (!skipError) {
      await assertActivityGone(activityId);
      return;
    }

    const { error: delError } = await supabase.from('activities').delete().eq('id', activityId);
    if (delError) throw delError;
    await assertActivityGone(activityId);
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

export async function saveActivity(userId: string, input: ActivityInput, activityId?: string) {
  if (input.privacy === 'group' && !input.group_id) {
    throw new Error('Select a group.');
  }
  if (input.privacy === 'invite' && !(input.invite_user_ids?.length)) {
    throw new Error('Select at least one friend to invite.');
  }
  const rules = input.is_recurring ? normalizeRules(input.recurrence_rules ?? []) : [];
  if (input.is_recurring && rules.length === 0) {
    throw new Error('Select at least one weekday for recurrence.');
  }
  if (input.is_recurring && rules.some((r) => !r.duration_minutes || r.duration_minutes < 15)) {
    throw new Error('Set a duration for each day (at least 15 min).');
  }
  if (input.is_recurring) {
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

  const capacity = input.max_participants;
  if (capacity == null || !Number.isFinite(capacity) || capacity < 1 || !Number.isInteger(capacity)) {
    throw new Error('Capacity must be a positive whole number.');
  }

  const weekdays = rules.map((r) => r.weekday);

  let endsAt = input.ends_at || null;
  let durationMinutes: number | null = null;

  if (input.is_recurring && input.starts_at) {
    const start = new Date(input.starts_at);
    const js = start.getDay();
    const iso = js === 0 ? 7 : js;
    const rule = rules.find((r) => r.weekday === iso) ?? rules[0];
    durationMinutes = rule.duration_minutes;
    endsAt = new Date(start.getTime() + durationMinutes * 60_000).toISOString();
  } else if (input.duration_minutes && input.duration_minutes >= 15 && input.starts_at) {
    durationMinutes = Math.max(15, Math.round(input.duration_minutes));
    endsAt = new Date(new Date(input.starts_at).getTime() + durationMinutes * 60_000).toISOString();
  }

  const payload: Record<string, unknown> = {
    title: input.title.trim(),
    description: null,
    starts_at: input.starts_at,
    ends_at: endsAt,
    price: Number(input.price) || 0,
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
    is_recurring: Boolean(input.is_recurring),
    finance_enabled: Boolean(input.finance_enabled),
    recurrence_weekdays: weekdays,
    recurrence_rules: rules,
    recurrence_until: input.is_recurring ? input.recurrence_until || null : null,
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
      .select('created_by')
      .eq('id', activityId)
      .maybeSingle();
    if (loadError) throw loadError;
    if (!existing) throw new Error('Event not found.');

    // created_by must stay the original creator
    delete payload.created_by;

    const { error } = await supabase.from('activities').update(payload).eq('id', activityId);
    if (error) throw error;
    await supabase.from('activity_invites').delete().eq('activity_id', activityId);

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
    if (input.is_recurring) {
      payload.series_privacy = input.privacy;
      payload.series_group_id = input.privacy === 'group' ? input.group_id || null : null;
      payload.series_invite_user_ids = inviteIds;
    } else {
      payload.series_privacy = null;
      payload.series_group_id = null;
      payload.series_invite_user_ids = [];
    }
    const { data, error } = await supabase.from('activities').insert(payload).select('id').single();
    if (error) throw error;
    id = data.id;
    if (!newId) {
      await supabase.from('activities').update({ series_id: id }).eq('id', id);
    }
    await Promise.all([
      supabase.from('activity_joins').insert({ activity_id: id!, user_id: userId }),
      syncActivityEditors(id!, userId, input.editor_user_ids ?? [], input.title),
    ]);
  }

  if (inviteIds.length && id) {
    const unique = Array.from(new Set(inviteIds));
    const rows = unique.map((uid) => ({
      activity_id: id!,
      user_id: uid,
      invited_by: userId,
    }));
    await supabase.from('activity_invites').upsert(rows, { onConflict: 'activity_id,user_id' });
    // Notifications must not block returning to the event screen
    void Promise.all(
      unique.map((uid) =>
        createNotification(uid, 'invite', `Invite to event: ${input.title}`, { activity_id: id })
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
    void Promise.all(
      newcomers.map((uid) =>
        createNotification(uid, 'editor', `You can edit the event: ${title}`, {
          activity_id: activityId,
        })
      )
    );
  }
}
