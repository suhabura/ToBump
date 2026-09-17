import { differenceInCalendarDays, format, startOfDay } from 'date-fns';
import { enUS } from 'date-fns/locale';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Button, Chip, EmptyState, Loading, Muted, Screen, Subtitle } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { leaveActivity, processDueRecurringActivities } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import type { ActivityWithRelations } from '@/lib/types';
import { activityLocationLabel, categoryLabel } from '@/lib/types';
import { useT, type Translations } from '@/i18n';
import { theme } from '@/constants/theme';

type PlannerTab = 'upcoming' | 'past';

function relativeDayLabel(startsAt: Date, t: Translations, now = new Date()): string {
  const days = differenceInCalendarDays(startOfDay(startsAt), startOfDay(now));
  if (days <= 0) return t.planner.today;
  if (days === 1) return t.planner.tomorrow;
  if (days === 2) return t.planner.dayAfterTomorrow;
  return t.planner.inDays(days);
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

export default function PlannerScreen() {
  const t = useT();
  const { user } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<PlannerTab>('upcoming');
  const [items, setItems] = useState<ActivityWithRelations[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      await processDueRecurringActivities();
    } catch {
      /* optional */
    }
    const now = new Date().toISOString();
    const { data: joins } = await supabase
      .from('activity_joins')
      .select('activity_id')
      .eq('user_id', user.id);
    const ids = (joins ?? []).map((j) => j.activity_id);
    if (!ids.length) {
      setItems([]);
      setLoading(false);
      return;
    }

    const selectWithParent =
      '*, enterprises(id, name, address), categories(id, name, icon, parent_id)';
    const selectBasic = '*, enterprises(id, name, address), categories(id, name, icon)';

    let query = supabase.from('activities').select(selectWithParent).in('id', ids);

    if (tab === 'upcoming') {
      query = query.eq('status', 'active').gte('starts_at', now).order('starts_at', { ascending: true });
    } else {
      // Past attended: still visible when marked completed (or cleanup lag left them active)
      query = query
        .in('status', ['active', 'completed'])
        .lt('starts_at', now)
        .order('starts_at', { ascending: false });
    }

    const { data, error } = await query;
    let rows = (data as ActivityWithRelations[]) ?? [];
    if (error) {
      let fallback = supabase.from('activities').select(selectBasic).in('id', ids);
      if (tab === 'upcoming') {
        fallback = fallback
          .eq('status', 'active')
          .gte('starts_at', now)
          .order('starts_at', { ascending: true });
      } else {
        fallback = fallback
          .in('status', ['active', 'completed'])
          .lt('starts_at', now)
          .order('starts_at', { ascending: false });
      }
      const retry = await fallback;
      rows = (retry.data as ActivityWithRelations[]) ?? [];
    }

    rows = await hydrateParents(rows);
    setItems(rows);
    setLoading(false);
  }, [user?.id, tab]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  async function onLeave(id: string) {
    if (!user) return;
    await leaveActivity(id, user.id);
    load();
  }

  return (
    <Screen>
      <View style={styles.tabs}>
        <Chip
          label={t.planner.upcoming}
          active={tab === 'upcoming'}
          onPress={() => setTab('upcoming')}
        />
        <Chip label={t.planner.past} active={tab === 'past'} onPress={() => setTab('past')} />
      </View>

      {loading ? (
        <Loading />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          ListEmptyComponent={
            <EmptyState title={tab === 'past' ? t.planner.emptyPast : t.planner.empty} />
          }
          renderItem={({ item }) => {
            const starts = new Date(item.starts_at);
            const location = activityLocationLabel(item);
            return (
              <View style={styles.card}>
                <Pressable style={styles.cardBody} onPress={() => router.push(`/activity/${item.id}`)}>
                  <Subtitle>{categoryLabel(item.categories) ?? item.title}</Subtitle>
                  <Muted>
                    {format(starts, 'EEE, d MMM · HH:mm', { locale: enUS })}
                    {tab === 'upcoming' ? ` · ${relativeDayLabel(starts, t)}` : ''}
                  </Muted>
                  {location ? (
                    <Muted>
                      {t.events.location}: {location}
                    </Muted>
                  ) : null}
                </Pressable>
                {tab === 'upcoming' ? (
                  <View style={styles.actions} onStartShouldSetResponder={() => true}>
                    <Button
                      label={t.events.chat}
                      variant="secondary"
                      size="sm"
                      icon="comments"
                      onPress={() => router.push(`/chat/${item.id}`)}
                    />
                    <Button
                      label={t.events.leave}
                      variant="dangerOutline"
                      size="sm"
                      icon="sign-out"
                      onPress={() => onLeave(item.id)}
                    />
                  </View>
                ) : null}
              </View>
            );
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: theme.space.md,
  },
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
    backgroundColor: '#FBFCFB',
  },
});
