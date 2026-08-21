import { format } from 'date-fns';
import { enUS } from 'date-fns/locale';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, EmptyState, Input, Loading, Muted, Screen, Subtitle } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { fetchActivities } from '@/lib/api';
import { formatDistance } from '@/lib/geo';
import type { ActivityWithRelations } from '@/lib/types';
import { activityLocationLabel, categoryLabel, displayName } from '@/lib/types';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

export default function EventsScreen() {
  const t = useT();
  const { user, configured } = useAuth();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<ActivityWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const userId = user?.id;

  const load = useCallback(async () => {
    if (!userId || !configured) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchActivities({
        userId,
        filter: 'feed',
        search,
      });
      setItems(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.common.error);
    } finally {
      setLoading(false);
    }
  }, [userId, configured, search, t.common.error]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  if (!configured) {
    return (
      <Screen>
        <EmptyState title="Supabase not configured" subtitle={t.common.configureSupabase} />
      </Screen>
    );
  }

  return (
    <Screen style={{ paddingBottom: 0 }}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Input
            placeholder={t.events.search}
            value={search}
            onChangeText={setSearch}
            onSubmitEditing={load}
            style={{ marginBottom: 0 }}
          />
        </View>
      </View>

      <Button label={t.events.create} onPress={() => router.push('/activity/create')} />
      <View style={{ height: 12 }} />

      {loading ? (
        <Loading />
      ) : error ? (
        <EmptyState title={error} subtitle={t.common.retry} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: 32 }}
          ListEmptyComponent={<EmptyState title={t.events.empty} />}
          renderItem={({ item }) => {
            const isOrganizer = item.created_by === user?.id;
            const location = activityLocationLabel(item);
            const priceNum = Number(item.price ?? 0);
            const cat = categoryLabel(item.categories) ?? `${item.title} (${t.events.uncategorized})`;
            return (
              <Pressable
                style={[styles.card, isOrganizer ? styles.cardMine : null]}
                onPress={() => router.push(`/activity/${item.id}`)}>
                {isOrganizer ? (
                  <View style={styles.organizerRow}>
                    <Text style={styles.organizerBadge}>{t.events.organizing}</Text>
                  </View>
                ) : null}
                <Subtitle>{cat}</Subtitle>
                <Muted>
                  {format(new Date(item.starts_at), 'EEE, d MMM yyyy · HH:mm', { locale: enUS })}
                </Muted>
                {location ? (
                  <Muted>
                    {t.events.location}: {location}
                    {item.distance_m != null ? ` · ${formatDistance(item.distance_m)}` : ''}
                  </Muted>
                ) : null}
                <Muted>
                  {t.events.price}: {priceNum > 0 ? `${priceNum} €` : t.common.free}
                  {isOrganizer ? null : ` · ${displayName(item.profiles)}`}
                </Muted>
                <View style={styles.meta}>
                  {!isOrganizer && item.is_invited ? (
                    <Text style={[styles.badge, styles.invited]}>{t.events.invitedBadge}</Text>
                  ) : null}
                  {!isOrganizer && item.is_open_to_you && !item.is_invited ? (
                    <Text style={[styles.badge, styles.friend]}>{t.events.openToYou}</Text>
                  ) : null}
                  {!isOrganizer && item.is_from_friend && !item.is_invited && !item.is_open_to_you ? (
                    <Text style={[styles.badge, styles.friend]}>{t.events.friend}</Text>
                  ) : null}
                  <Text style={styles.badge}>
                    {item.join_count ?? 0}
                    {item.max_participants ? `/${item.max_participants}` : ''}{' '}
                    {t.events.participants.toLowerCase()}
                  </Text>
                  {item.is_joined && !isOrganizer ? (
                    <Text style={[styles.badge, styles.joined]}>{t.events.joined}</Text>
                  ) : null}
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { marginBottom: theme.space.sm },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: theme.space.sm,
  },
  cardMine: {
    borderColor: theme.colors.primary,
    borderWidth: 2,
    borderLeftWidth: 6,
    backgroundColor: theme.colors.primarySoft,
  },
  organizerRow: { marginBottom: 8 },
  organizerBadge: {
    alignSelf: 'flex-start',
    backgroundColor: theme.colors.primary,
    color: '#fff',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    overflow: 'hidden',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  meta: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  badge: {
    backgroundColor: theme.colors.primarySoft,
    color: theme.colors.primaryDark,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    overflow: 'hidden',
    fontSize: 12,
    fontWeight: '600',
  },
  joined: { backgroundColor: '#DCFCE7', color: theme.colors.success },
  invited: { backgroundColor: '#FEF3C7', color: '#92400E' },
  friend: { backgroundColor: '#DBEAFE', color: '#1E40AF' },
});
