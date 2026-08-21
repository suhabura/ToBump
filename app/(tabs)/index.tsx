import { format } from 'date-fns';
import { enUS } from 'date-fns/locale';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Button, EmptyState, Input, Loading, Muted, Screen, Subtitle } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { fetchActivities, joinActivity, leaveActivity } from '@/lib/api';
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
  const [busyId, setBusyId] = useState<string | null>(null);

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

  async function onJoin(item: ActivityWithRelations) {
    if (!user) return;
    const full = item.max_participants != null && (item.join_count ?? 0) >= item.max_participants;
    if (full) return;
    setBusyId(item.id);
    try {
      await joinActivity(item.id, user.id, item.created_by, item.title);
      await load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusyId(null);
    }
  }

  async function onLeave(item: ActivityWithRelations) {
    if (!user) return;
    setBusyId(item.id);
    try {
      await leaveActivity(item.id, user.id);
      await load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusyId(null);
    }
  }

  if (!configured) {
    return (
      <Screen>
        <EmptyState title="Supabase not configured" subtitle={t.common.configureSupabase} />
      </Screen>
    );
  }

  return (
    <Screen style={{ paddingBottom: 0 }}>
      <View style={styles.toolbar}>
        <Input
          placeholder={t.events.search}
          value={search}
          onChangeText={setSearch}
          onSubmitEditing={load}
          containerStyle={{ marginBottom: 0 }}
        />
        <Button
          label={t.events.create}
          icon="plus"
          size="sm"
          onPress={() => router.push('/activity/create')}
        />
      </View>

      {loading ? (
        <Loading />
      ) : error ? (
        <EmptyState title={error} subtitle={t.common.retry} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: 32, paddingTop: 4 }}
          ListEmptyComponent={<EmptyState title={t.events.empty} />}
          renderItem={({ item }) => {
            const isOrganizer = item.created_by === user?.id;
            const joined = Boolean(item.is_joined);
            const full =
              item.max_participants != null && (item.join_count ?? 0) >= item.max_participants;
            const location = activityLocationLabel(item);
            const priceNum = Number(item.price ?? 0);
            const cat = categoryLabel(item.categories) ?? `${item.title} (${t.events.uncategorized})`;
            const busy = busyId === item.id;
            return (
              <View style={[styles.card, isOrganizer ? styles.cardMine : null]}>
                <Pressable onPress={() => router.push(`/activity/${item.id}`)} style={styles.cardBody}>
                  <View style={styles.cardTop}>
                    {isOrganizer ? (
                      <Text style={styles.organizerBadge}>{t.events.organizing}</Text>
                    ) : item.is_invited ? (
                      <Text style={[styles.tag, styles.tagInvited]}>{t.events.invitedBadge}</Text>
                    ) : item.is_open_to_you ? (
                      <Text style={[styles.tag, styles.tagOpen]}>{t.events.openToYou}</Text>
                    ) : item.is_from_friend ? (
                      <Text style={[styles.tag, styles.tagOpen]}>{t.events.friend}</Text>
                    ) : (
                      <View />
                    )}
                    <Text style={styles.count}>
                      <FontAwesome name="users" size={11} color={theme.colors.textMuted} />{' '}
                      {item.join_count ?? 0}
                      {item.max_participants ? `/${item.max_participants}` : ''}
                    </Text>
                  </View>

                  <Subtitle>{cat}</Subtitle>
                  <Text style={styles.when}>
                    {format(new Date(item.starts_at), 'EEE, d MMM · HH:mm', { locale: enUS })}
                  </Text>
                  {location ? (
                    <Text style={styles.metaLine} numberOfLines={1}>
                      <FontAwesome name="map-marker" size={12} color={theme.colors.textMuted} />{' '}
                      {location}
                      {item.distance_m != null ? ` · ${formatDistance(item.distance_m)}` : ''}
                    </Text>
                  ) : null}
                  <Text style={styles.metaLine}>
                    {priceNum > 0 ? `${priceNum} €` : t.common.free}
                    {isOrganizer ? null : ` · ${displayName(item.profiles)}`}
                  </Text>
                </Pressable>

                <View style={styles.actions}>
                  {joined ? (
                    <>
                      <View style={styles.actionFlex}>
                        <Button
                          label={t.events.chat}
                          variant="secondary"
                          size="sm"
                          icon="comments"
                          onPress={() => router.push(`/chat/${item.id}`)}
                        />
                      </View>
                      <View style={styles.actionFlex}>
                        <Button
                          label={t.events.leave}
                          variant="dangerOutline"
                          size="sm"
                          icon="sign-out"
                          loading={busy}
                          onPress={() => onLeave(item)}
                        />
                      </View>
                    </>
                  ) : (
                    <Button
                      label={full ? t.events.full : t.events.join}
                      disabled={full}
                      loading={busy}
                      size="sm"
                      icon="check"
                      onPress={() => onJoin(item)}
                    />
                  )}
                </View>
              </View>
            );
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    gap: 10,
    marginBottom: theme.space.sm,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: 12,
    overflow: 'hidden',
    ...theme.shadow.card,
  },
  cardMine: {
    borderColor: theme.colors.primaryMuted,
    backgroundColor: '#F3FAF7',
  },
  cardBody: {
    padding: theme.space.md,
    paddingBottom: 12,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    gap: 8,
  },
  organizerBadge: {
    backgroundColor: theme.colors.primary,
    color: '#fff',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  tag: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
    fontSize: 11,
    fontWeight: '700',
  },
  tagInvited: {
    backgroundColor: theme.colors.warningSoft,
    color: '#92400E',
  },
  tagOpen: {
    backgroundColor: theme.colors.infoSoft,
    color: theme.colors.info,
  },
  count: {
    color: theme.colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  when: {
    color: theme.colors.primaryDark,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  metaLine: {
    color: theme.colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: theme.space.md,
    paddingBottom: theme.space.md,
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: '#FBFCFB',
  },
  actionFlex: { flex: 1 },
});
