import { differenceInCalendarDays, format, startOfDay } from 'date-fns';
import { enUS } from 'date-fns/locale';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Button, EmptyState, Loading, Muted, Screen, Subtitle } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { leaveActivity } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import type { ActivityWithRelations } from '@/lib/types';
import { activityLocationLabel, categoryLabel } from '@/lib/types';
import { useT, type Translations } from '@/i18n';
import { theme } from '@/constants/theme';

function relativeDayLabel(startsAt: Date, t: Translations, now = new Date()): string {
  const days = differenceInCalendarDays(startOfDay(startsAt), startOfDay(now));
  if (days <= 0) return t.planner.today;
  if (days === 1) return t.planner.tomorrow;
  if (days === 2) return t.planner.dayAfterTomorrow;
  return t.planner.inDays(days);
}

export default function PlannerScreen() {
  const t = useT();
  const { user } = useAuth();
  const router = useRouter();
  const [items, setItems] = useState<ActivityWithRelations[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
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
    const { data, error } = await supabase
      .from('activities')
      .select('*, enterprises(id, name, address), categories(id, name, icon, parent_id)')
      .in('id', ids)
      .eq('status', 'active')
      .gte('starts_at', now)
      .order('starts_at', { ascending: true });

    let rows = (data as ActivityWithRelations[]) ?? [];
    if (error) {
      const retry = await supabase
        .from('activities')
        .select('*, enterprises(id, name, address), categories(id, name, icon)')
        .in('id', ids)
        .eq('status', 'active')
        .gte('starts_at', now)
        .order('starts_at', { ascending: true });
      rows = (retry.data as ActivityWithRelations[]) ?? [];
    }

    const parentIds = Array.from(
      new Set(
        rows
          .map((a) => (a.categories as { parent_id?: string | null } | null)?.parent_id)
          .filter((id): id is string => Boolean(id))
      )
    );
    if (parentIds.length) {
      const { data: parents } = await supabase.from('categories').select('id, name').in('id', parentIds);
      const map = new Map((parents ?? []).map((p: { id: string; name: string }) => [p.id, p.name]));
      rows = rows.map((a) => {
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

    setItems(rows as ActivityWithRelations[]);
    setLoading(false);
  }, [user?.id]);

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

  if (loading) return <Loading />;

  return (
    <Screen>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        ListEmptyComponent={<EmptyState title={t.planner.empty} />}
        renderItem={({ item }) => {
          const starts = new Date(item.starts_at);
          const location = activityLocationLabel(item);
          return (
            <View style={styles.card}>
              <Pressable onPress={() => router.push(`/activity/${item.id}`)}>
                <Subtitle>{categoryLabel(item.categories) ?? item.title}</Subtitle>
                <Muted>
                  {format(starts, 'EEE, d MMM · HH:mm', { locale: enUS })} · {relativeDayLabel(starts, t)}
                </Muted>
                {location ? <Muted>{t.events.location}: {location}</Muted> : null}
              </Pressable>
              <View style={styles.actions}>
                <View style={{ flex: 1 }}>
                  <Button
                    label={t.events.chat}
                    variant="secondary"
                    onPress={() => router.push(`/chat/${item.id}`)}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button label={t.events.leave} variant="danger" onPress={() => onLeave(item.id)} />
                </View>
              </View>
            </View>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: theme.space.sm,
  },
  actions: { marginTop: 12, gap: 8 },
});
