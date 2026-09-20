import { format } from 'date-fns';
import { enUS, sl as slLocale } from 'date-fns/locale';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Button, EmptyState, Input, Loading, Screen, Subtitle } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { fetchActivities, joinActivity, leaveActivity } from '@/lib/api';
import { formatDistance } from '@/lib/geo';
import { supabase } from '@/lib/supabase';
import type { ActivityWithRelations } from '@/lib/types';
import { activityCapacityRange, activityLocationLabel, activityPriceLabel, categoryLabel, displayName } from '@/lib/types';
import { useLocale, useT } from '@/i18n';
import { theme } from '@/constants/theme';

export default function EventsScreen() {
  const t = useT();
  const { locale } = useLocale();
  const dfLocale = locale === 'sl' ? slLocale : enUS;
  const { user, configured } = useAuth();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<ActivityWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLoaded = useRef(false);

  const userId = user?.id;

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!userId || !configured) {
        setLoading(false);
        return;
      }
      if (!opts?.silent || !hasLoaded.current) {
        setLoading(true);
      }
      setError(null);
      try {
        const data = await fetchActivities({
          userId,
          filter: 'feed',
          search,
        });
        setItems(data);
        hasLoaded.current = true;
      } catch (e) {
        setError(e instanceof Error ? e.message : t.common.error);
      } finally {
        setLoading(false);
      }
    },
    [userId, configured, search, t.common.error]
  );

  const scheduleLiveReload = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      void load({ silent: true });
    }, 250);
  }, [load]);

  // Drop events from the list the moment they start (without waiting for focus)
  useEffect(() => {
    const now = Date.now();
    const nextStart = items
      .map((a) => new Date(a.starts_at).getTime())
      .filter((t) => t > now)
      .sort((a, b) => a - b)[0];
    if (nextStart == null) return;
    const delay = Math.min(Math.max(nextStart - now + 100, 100), 2_147_483_647);
    const timer = setTimeout(() => {
      setItems((prev) => prev.filter((a) => new Date(a.starts_at).getTime() > Date.now()));
      void load({ silent: true });
    }, delay);
    return () => clearTimeout(timer);
  }, [items, load]);

  useFocusEffect(
    useCallback(() => {
      void load();
      if (!userId || !configured) return;

      const channel = supabase
        .channel(`events-live-${userId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'activity_joins' },
          () => scheduleLiveReload()
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'activity_guest_attendances' },
          () => scheduleLiveReload()
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'activities' },
          () => scheduleLiveReload()
        )
        .subscribe();

      return () => {
        if (reloadTimer.current) clearTimeout(reloadTimer.current);
        supabase.removeChannel(channel);
      };
    }, [load, userId, configured, scheduleLiveReload])
  );

  async function onJoin(item: ActivityWithRelations) {
    if (!user) return;
    const full = item.max_participants != null && (item.join_count ?? 0) >= item.max_participants;
    if (full) return;
    setBusyId(item.id);
    try {
      await joinActivity(item.id, user.id, item.created_by, item.title);
      await load({ silent: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : t.common.error;
      Alert.alert(t.common.error, /full/i.test(msg) ? t.events.eventFull : msg);
      await load({ silent: true });
    } finally {
      setBusyId(null);
    }
  }

  async function onLeave(item: ActivityWithRelations) {
    if (!user) return;
    setBusyId(item.id);
    try {
      await leaveActivity(item.id, user.id);
      await load({ silent: true });
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
          onSubmitEditing={() => void load()}
          containerStyle={{ marginBottom: 0 }}
        />
        <Button
          label={t.events.create}
          icon="plus"
          size="sm"
          onPress={() => router.push('/activity/create')}
        />
      </View>

      {loading && !hasLoaded.current ? (
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
            const capRange = activityCapacityRange(item);
            const cat = categoryLabel(item.categories) ?? item.title;
            const busy = busyId === item.id;
            const host = isOrganizer ? '' : displayName(item.profiles);
            const role = isOrganizer
              ? { label: t.events.organizing, style: styles.roleOrganizing }
              : item.is_invited
                ? { label: host ? t.events.invitedBy(host) : t.events.invitedBadge, style: styles.roleInvited }
                : item.is_open_to_you
                  ? {
                      label: host ? `${t.events.openToYou} · ${host}` : t.events.openToYou,
                      style: styles.roleQuiet,
                    }
                  : item.is_from_friend
                    ? { label: host ? `${t.events.friend} · ${host}` : t.events.friend, style: styles.roleQuiet }
                    : host
                      ? { label: host, style: styles.roleQuiet }
                      : null;
            return (
              <View style={[styles.card, isOrganizer ? styles.cardMine : null]}>
                <View style={styles.cardMain}>
                  <Pressable
                    style={styles.cardBody}
                    onPress={() => router.push(`/activity/${item.id}`)}
                  >
                    {role ? (
                      <Text style={[styles.overline, role.style]} numberOfLines={1}>
                        {role.label}
                      </Text>
                    ) : null}
                    <Subtitle>{cat}</Subtitle>
                    <Text style={styles.when}>
                      {format(new Date(item.starts_at), 'EEE, d MMM · HH:mm', { locale: dfLocale })}
                    </Text>
                    {location ? (
                      <Text style={styles.metaLine} numberOfLines={1}>
                        <FontAwesome name="map-marker" size={12} color={theme.colors.textMuted} />{' '}
                        {location}
                        {item.distance_m != null ? ` · ${formatDistance(item.distance_m)}` : ''}
                      </Text>
                    ) : null}
                    <Text style={styles.metaLine}>{activityPriceLabel(item, t.common)}</Text>
                    <Text style={styles.metaLine}>
                      <FontAwesome name="users" size={11} color={theme.colors.textMuted} />{' '}
                      {t.events.joinedCount}: {item.join_count ?? 0}
                      {capRange ? ` · ${t.events.capacity}: ${capRange}` : ''}
                    </Text>
                  </Pressable>
                </View>

                <View style={styles.actions} onStartShouldSetResponder={() => true}>
                  {joined ? (
                    <>
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
                        loading={busy}
                        onPress={() => void onLeave(item)}
                      />
                    </>
                  ) : (
                    <Button
                      label={full ? t.events.full : t.events.join}
                      disabled={full}
                      loading={busy}
                      size="sm"
                      icon="check"
                      onPress={() => void onJoin(item)}
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
    width: '100%',
    flexDirection: 'row',
    alignItems: 'stretch',
    flexWrap: 'nowrap',
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
    backgroundColor: theme.colors.primarySoft,
  },
  cardMain: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
  },
  cardBody: {
    flexGrow: 1,
    padding: theme.space.md,
  },
  overline: {
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 14,
    marginBottom: 4,
  },
  roleOrganizing: { color: theme.colors.primaryDark },
  roleInvited: { color: theme.colors.warning },
  roleQuiet: { color: theme.colors.textMuted },
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
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'stretch',
    gap: 6,
    width: 148,
    minWidth: 148,
    maxWidth: 148,
    paddingVertical: theme.space.md,
    paddingHorizontal: 10,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceElevated,
  },
});
