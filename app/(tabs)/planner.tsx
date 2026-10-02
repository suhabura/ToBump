import {
  addDays,
  addMonths,
  endOfMonth,
  endOfWeek,
  endOfDay,
  format,
  isSameDay,
  isSameMonth,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { enUS, sl as slLocale } from 'date-fns/locale';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { WeatherBadge } from '@/components/WeatherBadge';
import { Button, EmptyState, Loading, Screen, Subtitle } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { ensureDueRecurringActivities } from '@/lib/api';
import { seriesKey } from '@/lib/finance';
import {
  canUseChat,
  expandSeriesSlots,
  isSeriesActivity,
  localDayKey,
  seriesEndFromRows,
} from '@/lib/recurrence';
import {
  fetchSeriesFollows,
  fetchSkippedDays,
  joinSeriesOccurrence,
  openSeriesOccurrence,
  subscribeSeriesFollows,
} from '@/lib/seriesPlanner';
import { supabase } from '@/lib/supabase';
import type { ActivityWithRelations } from '@/lib/types';
import { activityCapacityRange, activityLocationLabel, activityPriceLabel, displayName, eventIsFull } from '@/lib/types';
import { eventWeatherPoint } from '@/lib/weather';
import { showAlert } from '@/lib/dialog';
import { useLocale, useT } from '@/i18n';
import { theme } from '@/constants/theme';

type PlannerItem = ActivityWithRelations & {
  slotKey: string;
  virtual?: boolean;
  skipped?: boolean;
};

function bumpJoinCount<T extends { activity_joins?: unknown }>(row: T, delta: number): T {
  const joins = row.activity_joins;
  if (Array.isArray(joins) && joins[0] && typeof joins[0] === 'object' && joins[0] && 'count' in joins[0]) {
    const count = Math.max(0, Number((joins[0] as { count: number }).count) + delta);
    return { ...row, activity_joins: [{ ...(joins[0] as object), count }] };
  }
  return { ...row, activity_joins: [{ count: Math.max(0, delta) }] };
}

function signupCount(row: { activity_joins?: unknown; activity_guest_attendances?: unknown }): number {
  const nested = (rel: unknown) => {
    if (Array.isArray(rel) && rel[0] && typeof rel[0] === 'object' && 'count' in (rel[0] as object)) {
      return Number((rel[0] as { count: number }).count) || 0;
    }
    return 0;
  };
  return nested(row.activity_joins) + nested(row.activity_guest_attendances);
}

function dayKey(d: Date): string {
  return format(startOfDay(d), 'yyyy-MM-dd');
}

type DayFlags = { joined: boolean; planner: boolean };

function DayMarks({ flags, selected }: { flags?: DayFlags; selected: boolean }) {
  return (
    <View style={styles.markRow}>
      {flags?.joined ? <View style={[styles.dot, { backgroundColor: selected ? '#fff' : theme.colors.primary }]} /> : null}
      {flags?.planner ? <View style={[styles.dot, { backgroundColor: selected ? '#fff' : '#E6B325' }]} /> : null}
    </View>
  );
}

function buildCalendarDays(month: Date): Date[] {
  const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const end = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
  const days: Date[] = [];
  let cur = start;
  while (cur <= end) {
    days.push(cur);
    cur = addDays(cur, 1);
  }
  return days;
}

async function hydrateParents(rows: ActivityWithRelations[]): Promise<ActivityWithRelations[]> {
  const parentIds = Array.from(
    new Set(
      rows
        .map((a) => (a.categories as { parent_id?: string | null } | null)?.parent_id)
        .filter((id): id is string => Boolean(id))
    )
  );
  if (!parentIds.length) return rows;
  const { data: parents } = await supabase.from('categories').select('id, name').in('id', parentIds);
  const map = new Map((parents ?? []).map((p: { id: string; name: string }) => [p.id, p.name]));
  return rows.map((a) => {
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
    return { ...a, categories: { ...cat, parent: { id: cat.parent_id, name } } };
  }) as ActivityWithRelations[];
}

const PLANNER_PAST_DAYS = 90;
const PLANNER_SELECT_WITH_PARENT =
    '*, profiles:created_by(id, first_name, last_name), enterprises(id, name, address, latitude, longitude), categories(id, name, icon, parent_id), activity_joins(count), activity_guest_attendances(count)';
const PLANNER_SELECT_BASIC =
  '*, profiles:created_by(id, first_name, last_name), enterprises(id, name, address, latitude, longitude), categories(id, name, icon), activity_joins(count), activity_guest_attendances(count)';

async function fetchMineAndJoined(
  userId: string,
  joinIds: string[],
  windowStart: Date,
  windowEnd: Date
): Promise<ActivityWithRelations[]> {
  const pastFrom = new Date();
  pastFrom.setDate(pastFrom.getDate() - PLANNER_PAST_DAYS);
  const windowFromIso = windowStart.toISOString();
  const windowToIso = endOfDay(windowEnd).toISOString();
  const pastFromIso = pastFrom.toISOString();
  const nowIso = new Date().toISOString();

  async function load(select: string) {
    const created = () => supabase.from('activities').select(select).eq('created_by', userId);
    const joined = () => supabase.from('activities').select(select).in('id', joinIds);
    const templateFilter = (query: ReturnType<typeof created>) =>
      query.eq('status', 'active').eq('is_recurring', true).lte('starts_at', windowToIso);

    const createdWindow = created()
      .in('status', ['active', 'completed'])
      .gte('starts_at', windowFromIso)
      .lte('starts_at', windowToIso)
      .order('starts_at', { ascending: true });
    const createdPast = created()
      .in('status', ['active', 'completed'])
      .gte('starts_at', pastFromIso)
      .lte('starts_at', nowIso)
      .order('starts_at', { ascending: true });
    const createdTemplates = templateFilter(created());

    const empty = Promise.resolve({ data: [] as ActivityWithRelations[], error: null });
    const joinedWindow = joinIds.length
      ? joined()
          .in('status', ['active', 'completed'])
          .gte('starts_at', windowFromIso)
          .lte('starts_at', windowToIso)
          .order('starts_at', { ascending: true })
      : empty;
    const joinedPast = joinIds.length
      ? joined()
          .in('status', ['active', 'completed'])
          .gte('starts_at', pastFromIso)
          .lte('starts_at', nowIso)
          .order('starts_at', { ascending: true })
      : empty;
    const joinedTemplates = joinIds.length ? templateFilter(joined()) : empty;

    const [cw, cp, ct, jw, jp, jt] = await Promise.all([
      createdWindow,
      createdPast,
      createdTemplates,
      joinedWindow,
      joinedPast,
      joinedTemplates,
    ]);
    const error = cw.error || cp.error || ct.error || jw.error || jp.error || jt.error;
    const data = [cw.data, cp.data, ct.data, jw.data, jp.data, jt.data].flatMap(
      (rows) => (rows as ActivityWithRelations[]) ?? []
    );
    return { data, error };
  }

  let { data, error } = await load(PLANNER_SELECT_WITH_PARENT);
  if (error) {
    const retry = await load(PLANNER_SELECT_BASIC);
    data = retry.data;
    error = retry.error;
  }
  if (error) throw error;

  const byId = new Map<string, ActivityWithRelations>();
  for (const row of data) {
    if (row?.id) byId.set(row.id, row);
  }
  return hydrateParents(Array.from(byId.values()));
}

async function fetchFollowedSeries(followIds: string[]): Promise<ActivityWithRelations[]> {
  if (!followIds.length) return [];
  const list = followIds.join(',');
  async function load(select: string) {
    const { data, error } = await supabase
      .from('activities')
      .select(select)
      .or(`id.in.(${list}),series_id.in.(${list})`)
      .in('status', ['active', 'completed']);
    return { data: (data as ActivityWithRelations[]) ?? [], error };
  }
  let { data, error } = await load(PLANNER_SELECT_WITH_PARENT);
  if (error) {
    const retry = await load(PLANNER_SELECT_BASIC);
    data = retry.data;
    error = retry.error;
  }
  if (error) throw error;
  const byId = new Map<string, ActivityWithRelations>();
  for (const row of data) {
    if (row?.id) byId.set(row.id, row);
  }
  return hydrateParents(Array.from(byId.values()));
}

async function fetchFutureJoins(joinIds: string[]): Promise<ActivityWithRelations[]> {
  if (!joinIds.length) return [];
  const nowIso = new Date().toISOString();

  async function load(select: string) {
    const { data, error } = await supabase
      .from('activities')
      .select(select)
      .in('id', joinIds)
      .eq('status', 'active')
      .gte('starts_at', nowIso)
      .order('starts_at', { ascending: true });
    return { data: (data as ActivityWithRelations[]) ?? [], error };
  }

  let { data, error } = await load(PLANNER_SELECT_WITH_PARENT);
  if (error) {
    const retry = await load(PLANNER_SELECT_BASIC);
    data = retry.data;
    error = retry.error;
  }
  if (error) throw error;

  const byId = new Map<string, ActivityWithRelations>();
  for (const row of data) {
    if (row?.id) byId.set(row.id, row);
  }
  return hydrateParents(Array.from(byId.values()));
}

/** Future events this person created, including full ones. Not limited to the visible month. */
async function fetchOrganizing(userId: string): Promise<ActivityWithRelations[]> {
  const nowIso = new Date().toISOString();

  async function load(select: string) {
    const { data, error } = await supabase
      .from('activities')
      .select(select)
      .eq('created_by', userId)
      .eq('status', 'active')
      .gte('starts_at', nowIso)
      .order('starts_at', { ascending: true });
    return { data: (data as ActivityWithRelations[]) ?? [], error };
  }

  let { data, error } = await load(PLANNER_SELECT_WITH_PARENT);
  if (error) {
    const retry = await load(PLANNER_SELECT_BASIC);
    data = retry.data;
    error = retry.error;
  }
  if (error) throw error;

  const byId = new Map<string, ActivityWithRelations>();
  for (const row of data) {
    if (row?.id) byId.set(row.id, row);
  }
  return hydrateParents(Array.from(byId.values()));
}

export default function PlannerScreen() {
  const t = useT();
  const { locale } = useLocale();
  const dfLocale = locale === 'sl' ? slLocale : enUS;
  const { user } = useAuth();
  const router = useRouter();
  const [items, setItems] = useState<ActivityWithRelations[]>([]);
  const [joinedFuture, setJoinedFuture] = useState<ActivityWithRelations[]>([]);
  const [organizingRows, setOrganizingRows] = useState<ActivityWithRelations[]>([]);
  const [joinedIds, setJoinedIds] = useState<Set<string>>(new Set());
  const [follows, setFollows] = useState<Set<string>>(new Set());
  const [skippedBySeries, setSkippedBySeries] = useState<Map<string, Set<string>>>(new Map());
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDay, setSelectedDay] = useState(() => startOfDay(new Date()));
  const [calendarOpen, setCalendarOpen] = useState(false);
  const hasLoaded = useRef(false);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipeX = useRef(new Animated.Value(0)).current;
  const peakDx = useRef(0);
  const swipeLock = useRef(false);
  const calWidth = useRef(280);
  const monthSwipe = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) =>
        !swipeLock.current && Math.abs(gesture.dx) > 14 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.3,
      onMoveShouldSetPanResponderCapture: (_, gesture) =>
        !swipeLock.current && Math.abs(gesture.dx) > 14 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.3,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        peakDx.current = 0;
        swipeX.stopAnimation();
        swipeX.setValue(0);
      },
      onPanResponderMove: (_, gesture) => {
        if (Math.abs(gesture.dx) > Math.abs(peakDx.current)) peakDx.current = gesture.dx;
        const limit = Math.max(calWidth.current, 160);
        swipeX.setValue(Math.max(-limit, Math.min(limit, gesture.dx)));
      },
      onPanResponderRelease: (_, gesture) => {
        if (swipeLock.current) return;
        const distance = Math.abs(peakDx.current) >= Math.abs(gesture.dx) ? peakDx.current : gesture.dx;
        const dir = Math.sign(distance);
        const flicked = Math.abs(gesture.vx) > 0.45 && Math.sign(gesture.vx) === dir;
        const commit = dir !== 0 && (Math.abs(distance) >= 56 || (flicked && Math.abs(distance) >= 28));
        if (!commit) {
          Animated.spring(swipeX, { toValue: 0, useNativeDriver: false, speed: 20, bounciness: 0 }).start();
          return;
        }
        swipeLock.current = true;
        const width = Math.max(calWidth.current, 160);
        const out = dir * width;
        Animated.timing(swipeX, { toValue: out, duration: 160, useNativeDriver: false }).start(({ finished }) => {
          if (!finished) {
            swipeLock.current = false;
            swipeX.setValue(0);
            return;
          }
          setMonth((current) => (dir < 0 ? addMonths(current, 1) : subMonths(current, 1)));
          swipeX.setValue(-out);
          Animated.timing(swipeX, { toValue: 0, duration: 180, useNativeDriver: false }).start(() => {
            swipeLock.current = false;
          });
        });
      },
      onPanResponderTerminate: () => {
        peakDx.current = 0;
        Animated.spring(swipeX, { toValue: 0, useNativeDriver: false, speed: 20, bounciness: 0 }).start();
      },
    })
  ).current;

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!user?.id) {
        setLoading(false);
        return;
      }
      if (!opts?.silent || !hasLoaded.current) {
        setLoading(true);
      }
      try {
        void ensureDueRecurringActivities();
        const grid = buildCalendarDays(month);
        const windowStart = grid[0] ?? startOfMonth(month);
        const windowEnd = grid[grid.length - 1] ?? endOfMonth(month);
        const { data: joins } = await supabase
          .from('activity_joins')
          .select('activity_id')
          .eq('user_id', user.id);
        const ids = (joins ?? []).map((j) => j.activity_id);
        setJoinedIds(new Set(ids));
        const followSet = await fetchSeriesFollows(user.id);
        const [mineRows, futureJoins, followedRows, createdFuture] = await Promise.all([
          fetchMineAndJoined(user.id, ids, windowStart, windowEnd),
          fetchFutureJoins(ids),
          fetchFollowedSeries([...followSet]),
          fetchOrganizing(user.id),
        ]);
        const rowsById = new Map<string, ActivityWithRelations>();
        for (const row of mineRows.concat(followedRows)) {
          if (row?.id) rowsById.set(row.id, row);
        }
        const rows = Array.from(rowsById.values());
        setItems(rows);
        setJoinedFuture(futureJoins);
        setOrganizingRows(createdFuture);
        const seriesIds = Array.from(
          new Set(rows.concat(futureJoins, createdFuture).map((a) => seriesKey(a)))
        );
        const skipped = await fetchSkippedDays(seriesIds);
        setFollows(followSet);
        setSkippedBySeries(skipped);
        hasLoaded.current = true;
      } finally {
        setLoading(false);
      }
    },
    [user?.id, month]
  );

  useEffect(() => {
    return subscribeSeriesFollows(() => {
      void load({ silent: true });
    });
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      void load({ silent: hasLoaded.current });
      if (!user?.id) return;

      const onJoinChange = (payload: {
        eventType?: string;
        new?: { activity_id?: string };
        old?: { activity_id?: string };
      }) => {
        const activityId = payload.new?.activity_id ?? payload.old?.activity_id;
        const delta = payload.eventType === 'INSERT' ? 1 : payload.eventType === 'DELETE' ? -1 : 0;
        if (activityId && delta) {
          setItems((prev) => prev.map((row) => (row.id === activityId ? bumpJoinCount(row, delta) : row)));
          setJoinedFuture((prev) =>
            prev.map((row) => (row.id === activityId ? bumpJoinCount(row, delta) : row))
          );
          setOrganizingRows((prev) =>
            prev.map((row) => (row.id === activityId ? bumpJoinCount(row, delta) : row))
          );
        }
        if (reloadTimer.current) clearTimeout(reloadTimer.current);
        reloadTimer.current = setTimeout(() => void load({ silent: true }), 250);
      };

      const channel = supabase
        .channel(`planner-live-${user.id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'activity_joins' }, onJoinChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'activity_declines' }, () => {
          if (reloadTimer.current) clearTimeout(reloadTimer.current);
          reloadTimer.current = setTimeout(() => void load({ silent: true }), 250);
        })
        .subscribe();

      const reloadActivities = () => {
        if (reloadTimer.current) clearTimeout(reloadTimer.current);
        reloadTimer.current = setTimeout(() => void load({ silent: true }), 250);
      };
      const activityChannel = supabase
        .channel(`planner-activity-${user.id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'activities' }, reloadActivities)
        .subscribe();

      const followChannel = supabase
        .channel(`planner-follow-${user.id}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'series_follows', filter: `user_id=eq.${user.id}` },
          () => {
            reloadActivities();
          }
        )
        .subscribe();

      return () => {
        if (reloadTimer.current) clearTimeout(reloadTimer.current);
        supabase.removeChannel(channel);
        supabase.removeChannel(activityChannel);
        supabase.removeChannel(followChannel);
      };
    }, [load, user?.id])
  );

  const days = useMemo(() => buildCalendarDays(month), [month]);
  const rangeStart = days[0] ?? startOfMonth(month);
  const rangeEnd = days[days.length - 1] ?? endOfMonth(month);

  const plannerItems = useMemo(() => {
    const templates = new Map<string, ActivityWithRelations>();
    const seriesRows = new Map<string, ActivityWithRelations[]>();
    const realByDay = new Map<string, ActivityWithRelations>();
    for (const a of items) {
      const sid = seriesKey(a);
      const prev = templates.get(sid);
      const aScore = (a.recurrence_dates?.length ?? 0) + (a.recurrence_rules?.length ?? 0);
      const pScore = prev ? (prev.recurrence_dates?.length ?? 0) + (prev.recurrence_rules?.length ?? 0) : -1;
      if (!prev || aScore > pScore) {
        templates.set(sid, a);
      }
      const rows = seriesRows.get(sid) ?? [];
      rows.push(a);
      seriesRows.set(sid, rows);
      realByDay.set(`${sid}:${localDayKey(new Date(a.starts_at))}`, a);
    }

    const seriesEnds = new Map<string, string | null>();
    for (const [sid, rows] of seriesRows) {
      seriesEnds.set(sid, seriesEndFromRows(rows));
    }

    const byKey = new Map<string, PlannerItem>();

    for (const a of items) {
      if (a.status === 'cancelled') continue;
      const sid = seriesKey(a);
      const day = localDayKey(new Date(a.starts_at));
      const end = seriesEnds.get(sid);
      const template = templates.get(sid);
      if (end && day > end && template && isSeriesActivity(template)) continue;
      byKey.set(`${sid}:${day}`, {
        ...a,
        join_count: signupCount(a),
        slotKey: `${sid}:${day}`,
        virtual: false,
        skipped: skippedBySeries.get(sid)?.has(day) ?? false,
      });
    }

    for (const [sid, template] of templates) {
      const series = isSeriesActivity(template);
      const isMine = template.created_by === user?.id;
      const followed = follows.has(sid);
      if (!series) continue;
      if (!isMine && !followed) continue;
      const skipped = skippedBySeries.get(sid) ?? new Set();
      let seriesStart = template.starts_at;
      for (const a of items) {
        if (seriesKey(a) !== sid) continue;
        if (new Date(a.starts_at).getTime() < new Date(seriesStart).getTime()) seriesStart = a.starts_at;
      }
      const rows = seriesRows.get(sid) ?? [template];
      const extraDates = Array.from(new Set(rows.flatMap((row) => row.recurrence_dates ?? [])));
      for (const slot of expandSeriesSlots(
        {
          ...template,
          starts_at: seriesStart,
          recurrence_until: seriesEnds.get(sid) ?? template.recurrence_until,
          recurrence_dates: extraDates,
        },
        rangeStart,
        rangeEnd,
        new Set()
      )) {
        const mapKey = `${sid}:${slot.day}`;
        const isSkipped = skipped.has(slot.day);
        const existing = byKey.get(mapKey);
        if (existing) {
          if (isSkipped) byKey.set(mapKey, { ...existing, skipped: true });
          continue;
        }
        if (realByDay.get(mapKey)) continue;
        const durationMs = slot.durationMinutes != null ? slot.durationMinutes * 60_000 : null;
        byKey.set(mapKey, {
          ...template,
          join_count: 0,
          starts_at: slot.startsAt.toISOString(),
          ends_at: durationMs != null ? new Date(slot.startsAt.getTime() + durationMs).toISOString() : null,
          duration_minutes: slot.durationMinutes,
          slotKey: mapKey,
          virtual: true,
          skipped: isSkipped,
        });
      }
    }

    return Array.from(byKey.values());
  }, [items, follows, skippedBySeries, rangeStart, rangeEnd, user?.id]);

  const dayMarks = useMemo(() => {
    const flags = new Map<string, DayFlags>();
    for (const a of plannerItems) {
      if (a.status === 'cancelled') continue;
      const key = localDayKey(new Date(a.starts_at));
      if (Number.isNaN(new Date(a.starts_at).getTime())) continue;
      const cur = flags.get(key) ?? { joined: false, planner: false };
      const joinedThis = !a.virtual && joinedIds.has(a.id);
      if (joinedThis) cur.joined = true;
      else cur.planner = true;
      flags.set(key, cur);
    }
    return flags;
  }, [plannerItems, joinedIds]);

  const selectedDayEvents = useMemo(() => {
    return plannerItems
      .filter(
        (a) =>
          a.status !== 'cancelled' &&
          isSameDay(new Date(a.starts_at), selectedDay)
      )
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }, [plannerItems, selectedDay]);

  const upcoming = useMemo(() => {
    const now = Date.now();
    const byKey = new Map<string, PlannerItem>();
    for (const a of joinedFuture) {
      if (a.status !== 'active') continue;
      const starts = new Date(a.starts_at);
      if (Number.isNaN(starts.getTime()) || starts.getTime() < now) continue;
      const sid = seriesKey(a);
      const day = localDayKey(starts);
      byKey.set(a.id, {
        ...a,
        join_count: signupCount(a),
        slotKey: a.id,
        virtual: false,
        skipped: skippedBySeries.get(sid)?.has(day) ?? false,
      });
    }
    return Array.from(byKey.values()).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }, [joinedFuture, skippedBySeries]);

  const organizing = useMemo(() => {
    const now = Date.now();
    const bySeries = new Map<string, PlannerItem>();
    for (const a of organizingRows) {
      if (a.created_by !== user?.id || a.status !== 'active') continue;
      const starts = new Date(a.starts_at);
      if (Number.isNaN(starts.getTime()) || starts.getTime() < now) continue;
      const sid = seriesKey(a);
      const day = localDayKey(starts);
      if (skippedBySeries.get(sid)?.has(day)) continue;
      const prev = bySeries.get(sid);
      if (prev && new Date(prev.starts_at).getTime() <= starts.getTime()) continue;
      bySeries.set(sid, {
        ...a,
        join_count: signupCount(a),
        slotKey: a.id,
        virtual: false,
        skipped: false,
      });
    }
    return Array.from(bySeries.values()).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }, [organizingRows, skippedBySeries, user?.id]);

  const following = useMemo(() => {
    const from = startOfDay(new Date());
    const horizon = addDays(from, 90);
    const joinedDay = new Set(
      joinedFuture
        .filter((a) => a.status === 'active')
        .map((a) => `${seriesKey(a)}:${localDayKey(new Date(a.starts_at))}`)
    );
    const bySeries = new Map<string, ActivityWithRelations[]>();
    for (const row of items) {
      const sid = seriesKey(row);
      if (!follows.has(sid) || row.created_by === user?.id) continue;
      const rows = bySeries.get(sid) ?? [];
      rows.push(row);
      bySeries.set(sid, rows);
    }
    const out: PlannerItem[] = [];
    for (const [sid, rows] of bySeries) {
      const template = rows.reduce((best, row) => {
        const score = (row.recurrence_dates?.length ?? 0) + (row.recurrence_rules?.length ?? 0);
        const bestScore = (best.recurrence_dates?.length ?? 0) + (best.recurrence_rules?.length ?? 0);
        return score > bestScore ? row : best;
      });
      const skipped = skippedBySeries.get(sid) ?? new Set<string>();
      if (!isSeriesActivity(template)) {
        const starts = new Date(template.starts_at);
        if (
          template.status !== 'cancelled' &&
          starts.getTime() >= Date.now() &&
          !joinedIds.has(template.id)
        ) {
          out.push({
            ...template,
            join_count: signupCount(template),
            slotKey: template.id,
            virtual: false,
            skipped: false,
          });
        }
        continue;
      }
      const endRaw = seriesEndFromRows(rows);
      const until = endRaw ? new Date(`${endRaw}T12:00:00`) : horizon;
      const rangeEnd = until.getTime() < horizon.getTime() ? until : horizon;
      let seriesStart = template.starts_at;
      for (const row of rows) {
        if (new Date(row.starts_at).getTime() < new Date(seriesStart).getTime()) seriesStart = row.starts_at;
      }
      const extraDates = Array.from(new Set(rows.flatMap((row) => row.recurrence_dates ?? [])));
      const realByDay = new Map(rows.map((row) => [`${sid}:${localDayKey(new Date(row.starts_at))}`, row]));
      for (const slot of expandSeriesSlots(
        {
          ...template,
          starts_at: seriesStart,
          recurrence_until: endRaw ?? template.recurrence_until,
          recurrence_dates: extraDates,
        },
        from,
        rangeEnd,
        new Set()
      )) {
        if (slot.startsAt.getTime() < Date.now()) continue;
        const mapKey = `${sid}:${slot.day}`;
        if (joinedDay.has(mapKey)) continue;
        const real = realByDay.get(mapKey);
        if (real?.status === 'cancelled' || (real && joinedIds.has(real.id))) continue;
        const durationMs = slot.durationMinutes != null ? slot.durationMinutes * 60_000 : null;
        if (real) {
          out.push({
            ...real,
            join_count: signupCount(real),
            slotKey: mapKey,
            virtual: false,
            skipped: skipped.has(slot.day),
          });
        } else {
          out.push({
            ...template,
            join_count: 0,
            starts_at: slot.startsAt.toISOString(),
            ends_at: durationMs != null ? new Date(slot.startsAt.getTime() + durationMs).toISOString() : null,
            duration_minutes: slot.durationMinutes,
            slotKey: mapKey,
            virtual: true,
            skipped: skipped.has(slot.day),
          });
        }
      }
    }
    return out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }, [items, follows, joinedFuture, joinedIds, skippedBySeries, user?.id]);

  const weekLabels = useMemo(
    () => days.slice(0, 7).map((d) => format(d, 'EEEEEE', { locale: dfLocale })),
    [days, dfLocale]
  );

  const today = startOfDay(new Date());
  const selectedIsToday = isSameDay(selectedDay, today);
  const selectedHeading = selectedIsToday
    ? t.planner.todayHeading
    : format(selectedDay, 'EEEE, d. M. yyyy', { locale: dfLocale });
  const categorySections = [
    following.length ? { key: 'following', title: t.planner.following, data: following } : null,
    upcoming.length ? { key: 'signed', title: t.planner.upcomingEvents, data: upcoming } : null,
    organizing.length ? { key: 'organizing', title: t.planner.organizing, data: organizing } : null,
  ].filter((section): section is { key: string; title: string; data: PlannerItem[] } => section != null);
  const sections = calendarOpen
    ? selectedDayEvents.length
      ? [{ key: 'day', title: '', data: selectedDayEvents }]
      : []
    : categorySections;
  const emptyTitle = calendarOpen ? t.planner.emptyDay : t.planner.emptyPlanner;

  async function onJoinSlot(item: PlannerItem) {
    if (!user) return;
    setBusyKey(item.slotKey);
    try {
      await joinSeriesOccurrence(item, new Date(item.starts_at), user.id);
      await load({ silent: true });
    } catch (e) {
      showAlert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusyKey(null);
    }
  }

  async function onOpenSlot(item: PlannerItem) {
    try {
      if (item.virtual) {
        const id = await openSeriesOccurrence(item, new Date(item.starts_at));
        router.push(`/activity/${id}`);
        return;
      }
      router.push(`/activity/${item.id}`);
    } catch (e) {
      showAlert(t.common.error, e instanceof Error ? e.message : t.common.error);
    }
  }

  function renderEventCard(item: PlannerItem) {
    const starts = new Date(item.starts_at);
    const location = activityLocationLabel(item);
    const future = starts.getTime() >= Date.now();
    const isMine = item.created_by === user?.id;
    const isJoined = !item.virtual && joinedIds.has(item.id);
    const busy = busyKey === item.slotKey;
    const cat = item.title;
    const host = isMine ? '' : displayName(item.profiles);
    const capRange = activityCapacityRange(item);
    const weather = eventWeatherPoint(item);
    const full = eventIsFull(item);
    const showJoin = future && !item.skipped && !isJoined;
    const sid = seriesKey(item);
    const seriesRows = plannerItems.filter((row) => seriesKey(row) === sid);
    const showChat = canUseChat({
      rows: seriesRows,
      activityId: item.id,
      joinedActivityIds: seriesRows.filter((row) => !row.virtual && joinedIds.has(row.id)).map((row) => row.id),
      followingSeries: follows.has(sid),
    });
    const lockedOut = !item.skipped && full && !isJoined;
    const fullIn = !item.skipped && full && isJoined;
    return (
      <View
        style={[
          styles.card,
          item.skipped || lockedOut ? styles.cardFull : null,
          fullIn ? styles.cardFullIn : null,
        ]}
      >
        {item.skipped ? (
          <View style={styles.skipBanner}>
            <Text style={styles.bannerText}>{t.planner.skipped}</Text>
          </View>
        ) : fullIn ? (
          <View style={styles.fullInBanner}>
            <Text style={styles.bannerText}>{t.events.fullJoined}</Text>
          </View>
        ) : lockedOut ? (
          <View style={styles.skipBanner}>
            <Text style={styles.bannerText}>{t.events.fullMissed}</Text>
          </View>
        ) : null}
        <Pressable style={[styles.cardBody, weather ? styles.cardBodyWeather : null]} onPress={() => void onOpenSlot(item)}>
          <Text style={[styles.overline, isMine ? styles.roleOrganizing : styles.roleInvited]} numberOfLines={1}>
            {isMine ? t.events.organizing : host ? t.events.invitedBy(host) : t.events.invitedBadge}
          </Text>
          <Text style={styles.cardTitle} numberOfLines={2}>
            {cat}
          </Text>
          <Text style={styles.when}>
            {format(starts, 'EEE, d MMM · HH:mm', { locale: dfLocale })}
          </Text>
          {location ? (
            <Text style={styles.metaLine} numberOfLines={1}>
              <FontAwesome name="map-marker" size={12} color={theme.colors.textMuted} /> {location}
            </Text>
          ) : null}
          {item.finance_enabled ? (
            <Text style={styles.metaLine}>{activityPriceLabel(item, t.common)}</Text>
          ) : null}
          <Text style={styles.metaLine}>
            <FontAwesome name="users" size={11} color={theme.colors.textMuted} /> {t.events.joinedCount}:{' '}
            {item.join_count ?? 0}
            {capRange ? ` · ${t.events.needed}: ${capRange}` : ''}
          </Text>
        </Pressable>
        {weather ? (
          <WeatherBadge latitude={weather.latitude} longitude={weather.longitude} startsAt={item.starts_at} />
        ) : null}
        {showChat || showJoin ? (
          <View style={styles.actions} onStartShouldSetResponder={() => true}>
            {showChat ? (
              <Button
                label={t.events.chat}
                variant="outline"
                size="xs"
                icon="comments"
                onPress={() => router.push(`/chat/${item.id}`)}
              />
            ) : null}
            {showJoin ? (
              <Button
                label={t.events.join}
                size="xs"
                icon="check"
                loading={busy}
                disabled={full || busy}
                onPress={() => void onJoinSlot(item)}
              />
            ) : null}
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <Screen>
      {loading && !hasLoaded.current ? (
        <Loading />
      ) : (
        <>
        <SectionList
          style={{ flex: 1 }}
          sections={sections}
          keyExtractor={(i) => i.slotKey}
          stickySectionHeadersEnabled={false}
          extraData={`${calendarOpen}:${dayKey(selectedDay)}:${joinedIds.size}:${follows.size}:${busyKey}:${organizing.length}:${following.length}`}
          contentContainerStyle={styles.listContent}
          renderSectionHeader={({ section }) =>
            section.title ? (
              <View style={styles.section}>
                <Subtitle>{section.title}</Subtitle>
              </View>
            ) : null
          }
          ListHeaderComponent={
            calendarOpen ? (
            <View style={styles.column}>
              <Pressable
                onPress={() => setCalendarOpen(false)}
                style={styles.backBtn}
                accessibilityRole="button"
                accessibilityLabel={t.planner.back}>
                <FontAwesome name="angle-left" size={18} color={theme.colors.primary} />
                <Text style={styles.backText}>{t.planner.back}</Text>
              </Pressable>
              <View style={styles.calCard}>
                <View style={styles.monthRow}>
                  <Pressable onPress={() => setMonth((m) => subMonths(m, 1))} style={styles.monthBtn}>
                    <Text style={styles.monthBtnText}>‹</Text>
                  </Pressable>
                  <Text style={styles.monthLabel}>
                    {format(month, 'LLLL yyyy', { locale: dfLocale })}
                  </Text>
                  <Pressable onPress={() => setMonth((m) => addMonths(m, 1))} style={styles.monthBtn}>
                    <Text style={styles.monthBtnText}>›</Text>
                  </Pressable>
                </View>
                <View style={styles.weekHeader}>
                  {weekLabels.map((label, i) => (
                    <Text key={`${label}-${i}`} style={styles.weekDay}>
                      {label}
                    </Text>
                  ))}
                </View>
                <View
                  style={styles.gridClip}
                  onLayout={(e) => {
                    calWidth.current = e.nativeEvent.layout.width;
                  }}
                >
                  <Animated.View style={[styles.grid, { transform: [{ translateX: swipeX }] }]} {...monthSwipe.panHandlers}>
                  {days.map((day) => {
                    const inMonth = isSameMonth(day, month);
                    const selected = isSameDay(day, selectedDay);
                    const isToday = isSameDay(day, today);
                    const mark = dayMarks.get(dayKey(day));
                    return (
                      <Pressable
                        key={day.toISOString()}
                        onPress={() => {
                          setSelectedDay(startOfDay(day));
                          if (!isSameMonth(day, month)) setMonth(startOfMonth(day));
                        }}
                        style={[
                          styles.dayCell,
                          selected && styles.daySelected,
                          isToday && !selected && styles.dayToday,
                        ]}>
                        <Text
                          style={[
                            styles.dayText,
                            !inMonth && styles.dayMuted,
                            selected && styles.dayTextSelected,
                          ]}>
                          {format(day, 'd')}
                        </Text>
                        <DayMarks flags={mark} selected={selected} />
                      </Pressable>
                    );
                  })}
                  </Animated.View>
                </View>
                <View style={styles.legend}>
                  <View style={styles.legendItem}>
                    <View style={[styles.dot, styles.dotJoined]} />
                    <Text style={styles.legendText}>{t.planner.legendJoined}</Text>
                  </View>
                  <View style={styles.legendItem}>
                    <View style={[styles.dot, styles.dotPlanner]} />
                    <Text style={styles.legendText}>{t.planner.legendPlanner}</Text>
                  </View>
                </View>
              </View>
              <View style={styles.section}>
                <Subtitle>{selectedHeading}</Subtitle>
              </View>
            </View>
            ) : null
          }
          ListEmptyComponent={<EmptyState title={emptyTitle} />}
          renderItem={({ item }) => renderEventCard(item)}
        />
        <View style={styles.fabWrap} pointerEvents="box-none">
          <Pressable
            onPress={() => setCalendarOpen(true)}
            style={({ pressed }) => [styles.fab, pressed ? { opacity: 0.9, transform: [{ scale: 0.96 }] } : null]}
            accessibilityRole="button"
            accessibilityLabel={t.planner.calendar}>
            <FontAwesome name="calendar" size={22} color="#fff" />
          </Pressable>
        </View>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingBottom: 96,
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
  },
  column: {
    width: '100%',
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginBottom: 12,
    paddingVertical: 4,
  },
  backText: {
    color: theme.colors.primary,
    fontWeight: '700',
    fontSize: 16,
  },
  fabWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 12,
    alignItems: 'center',
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#355A3C',
    shadowOpacity: 0.28,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  calCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.space.md,
    marginBottom: theme.space.lg,
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    ...theme.shadow.card,
  },
  monthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  monthBtn: { padding: 8, minWidth: 40, alignItems: 'center' },
  monthBtnText: { fontSize: 24, color: theme.colors.primary, fontWeight: '600' },
  monthLabel: {
    flex: 1,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '700',
    color: theme.colors.text,
    textTransform: 'capitalize',
  },
  weekHeader: { flexDirection: 'row', marginBottom: 4 },
  weekDay: {
    flex: 1,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
  },
  gridClip: { width: '100%', overflow: 'hidden' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: {
    width: '14.28%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
  },
  daySelected: { backgroundColor: theme.colors.primary },
  dayToday: {
    borderWidth: 1.5,
    borderColor: theme.colors.primary,
  },
  dayText: { fontSize: 15, color: theme.colors.text, fontWeight: '600' },
  dayMuted: { color: theme.colors.textMuted, fontWeight: '500' },
  dayTextSelected: { color: '#fff', fontWeight: '700' },
  markRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    marginTop: 2,
    minHeight: 9,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  dotJoined: { backgroundColor: theme.colors.primary },
  dotPlanner: { backgroundColor: '#E6B325' },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 16,
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendText: { fontSize: 12, fontWeight: '600', color: theme.colors.textMuted },
  section: { marginBottom: 12 },
  card: {
    width: '100%',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: 12,
    overflow: 'hidden',
    position: 'relative',
    ...theme.shadow.card,
  },
  cardFull: {
    borderColor: theme.colors.danger,
    backgroundColor: theme.colors.dangerSoft,
  },
  cardFullIn: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  skipBanner: {
    backgroundColor: theme.colors.danger,
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  fullInBanner: {
    backgroundColor: theme.colors.primary,
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  bannerText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  cardBody: {
    padding: theme.space.md,
    paddingBottom: 8,
  },
  cardBodyWeather: {
    paddingRight: 72,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.colors.text,
    letterSpacing: -0.2,
    lineHeight: 20,
  },
  overline: {
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 14,
    marginBottom: 4,
  },
  roleOrganizing: { color: theme.colors.primaryDark },
  roleInvited: { color: theme.colors.warning },
  when: {
    color: theme.colors.primaryDark,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
    marginTop: 1,
    marginBottom: 2,
  },
  metaLine: {
    color: theme.colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 1,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    paddingHorizontal: theme.space.md,
    paddingBottom: 10,
  },
});
