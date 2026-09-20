import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  endOfMonth,
  endOfWeek,
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
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, EmptyState, Loading, Muted, Screen, Subtitle } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { leaveActivity, processDueRecurringActivities } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import type { ActivityWithRelations } from '@/lib/types';
import { activityLocationLabel, categoryLabel } from '@/lib/types';
import { useLocale, useT, type Translations } from '@/i18n';
import { theme } from '@/constants/theme';

function relativeDayLabel(startsAt: Date, t: Translations, now = new Date()): string {
  const days = differenceInCalendarDays(startOfDay(startsAt), startOfDay(now));
  if (days <= 0) return t.planner.today;
  if (days === 1) return t.planner.tomorrow;
  if (days === 2) return t.planner.dayAfterTomorrow;
  return t.planner.inDays(days);
}

function dayKey(d: Date): string {
  return format(startOfDay(d), 'yyyy-MM-dd');
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

async function fetchMineAndJoined(
  userId: string,
  joinIds: string[]
): Promise<ActivityWithRelations[]> {
  const selectWithParent =
    '*, enterprises(id, name, address), categories(id, name, icon, parent_id)';
  const selectBasic = '*, enterprises(id, name, address), categories(id, name, icon)';

  async function load(select: string) {
    const created = await supabase
      .from('activities')
      .select(select)
      .eq('created_by', userId)
      .in('status', ['active', 'completed'])
      .order('starts_at', { ascending: true });
    const joined =
      joinIds.length > 0
        ? await supabase
            .from('activities')
            .select(select)
            .in('id', joinIds)
            .in('status', ['active', 'completed'])
            .order('starts_at', { ascending: true })
        : { data: [] as ActivityWithRelations[], error: null };
    return { created, joined };
  }

  let { created, joined } = await load(selectWithParent);
  if (created.error || joined.error) {
    const retry = await load(selectBasic);
    created = retry.created;
    joined = retry.joined;
  }

  const byId = new Map<string, ActivityWithRelations>();
  for (const row of [
    ...((created.data as ActivityWithRelations[]) ?? []),
    ...((joined.data as ActivityWithRelations[]) ?? []),
  ]) {
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
  const [joinedIds, setJoinedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDay, setSelectedDay] = useState(() => startOfDay(new Date()));

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      await processDueRecurringActivities();
    } catch {
      /* optional */
    }
    const { data: joins } = await supabase
      .from('activity_joins')
      .select('activity_id')
      .eq('user_id', user.id);
    const ids = (joins ?? []).map((j) => j.activity_id);
    setJoinedIds(new Set(ids));
    const rows = await fetchMineAndJoined(user.id, ids);
    setItems(rows);
    setLoading(false);
  }, [user?.id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const days = useMemo(() => buildCalendarDays(month), [month]);
  const eventDays = useMemo(() => {
    const set = new Set<string>();
    for (const a of items) {
      const d = new Date(a.starts_at);
      if (!Number.isNaN(d.getTime())) set.add(dayKey(d));
    }
    return set;
  }, [items]);

  const selectedDayEvents = useMemo(() => {
    return items
      .filter((a) => isSameDay(new Date(a.starts_at), selectedDay))
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }, [items, selectedDay]);

  const upcoming = useMemo(() => {
    const now = Date.now();
    return items
      .filter((a) => a.status === 'active' && new Date(a.starts_at).getTime() >= now)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }, [items]);

  const weekLabels = useMemo(
    () => days.slice(0, 7).map((d) => format(d, 'EEEEEE', { locale: dfLocale })),
    [days, dfLocale]
  );

  const today = startOfDay(new Date());
  const selectedIsToday = isSameDay(selectedDay, today);
  const selectedHeading = selectedIsToday
    ? t.planner.todayHeading
    : format(selectedDay, 'EEEE, d. M. yyyy', { locale: dfLocale });

  async function onLeave(id: string) {
    if (!user) return;
    await leaveActivity(id, user.id);
    load();
  }

  function renderEventCard(item: ActivityWithRelations, opts: { showRelative: boolean; allowActions: boolean }) {
    const starts = new Date(item.starts_at);
    const location = activityLocationLabel(item);
    const future = starts.getTime() >= Date.now();
    const isMine = item.created_by === user?.id;
    const isJoined = joinedIds.has(item.id);
    const showActions = opts.allowActions && future;
    return (
      <View style={styles.card}>
        <Pressable style={styles.cardBody} onPress={() => router.push(`/activity/${item.id}`)}>
          <View style={styles.cardTop}>
            <Subtitle>{categoryLabel(item.categories) ?? item.title}</Subtitle>
            {isMine ? <Text style={styles.tag}>{t.events.organizing}</Text> : null}
          </View>
          <Muted>
            {format(starts, 'EEE, d MMM · HH:mm', { locale: dfLocale })}
            {opts.showRelative ? ` · ${relativeDayLabel(starts, t)}` : ''}
          </Muted>
          {location ? (
            <Muted>
              {t.events.location}: {location}
            </Muted>
          ) : null}
        </Pressable>
        {showActions ? (
          <View style={styles.actions} onStartShouldSetResponder={() => true}>
            <Button
              label={t.events.chat}
              variant="secondary"
              size="sm"
              icon="comments"
              onPress={() => router.push(`/chat/${item.id}`)}
            />
            {isJoined && !isMine ? (
              <Button
                label={t.events.leave}
                variant="dangerOutline"
                size="sm"
                icon="sign-out"
                onPress={() => onLeave(item.id)}
              />
            ) : null}
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <Screen>
      {loading ? (
        <Loading />
      ) : (
        <FlatList
          data={upcoming}
          keyExtractor={(i) => i.id}
          extraData={`${dayKey(selectedDay)}:${joinedIds.size}`}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <View style={styles.column}>
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
                <View style={styles.grid}>
                  {days.map((day) => {
                    const inMonth = isSameMonth(day, month);
                    const selected = isSameDay(day, selectedDay);
                    const isToday = isSameDay(day, today);
                    const hasEvent = eventDays.has(dayKey(day));
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
                        <View
                          style={[
                            styles.dot,
                            hasEvent && (selected ? styles.dotOnSelected : styles.dotActive),
                          ]}
                        />
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              {selectedDayEvents.length ? (
                <View style={styles.section}>
                  <Subtitle>{selectedHeading}</Subtitle>
                  {selectedDayEvents.map((item) => (
                    <View key={`day-${item.id}`}>
                      {renderEventCard(item, {
                        showRelative: false,
                        allowActions: new Date(item.starts_at).getTime() >= Date.now(),
                      })}
                    </View>
                  ))}
                </View>
              ) : null}

              <View style={styles.section}>
                <Subtitle>{t.planner.upcoming}</Subtitle>
              </View>
            </View>
          }
          ListEmptyComponent={<EmptyState title={t.planner.empty} />}
          renderItem={({ item }) =>
            renderEventCard(item, { showRelative: true, allowActions: true })
          }
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingBottom: 32,
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
  },
  column: {
    width: '100%',
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
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    marginTop: 2,
    backgroundColor: 'transparent',
  },
  dotActive: { backgroundColor: theme.colors.accent },
  dotOnSelected: { backgroundColor: '#fff' },
  section: { marginBottom: theme.space.sm },
  card: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'stretch',
    flexWrap: 'nowrap',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: theme.space.sm,
    overflow: 'hidden',
    ...theme.shadow.card,
  },
  cardBody: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    padding: theme.space.md,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4,
  },
  tag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: 'hidden',
    fontSize: 11,
    fontWeight: '700',
    backgroundColor: theme.colors.primarySoft,
    color: theme.colors.primaryDark,
  },
  actions: {
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'stretch',
    gap: 6,
    minWidth: 128,
    paddingVertical: theme.space.md,
    paddingHorizontal: 10,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceElevated,
  },
});
