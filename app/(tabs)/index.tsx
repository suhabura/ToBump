import { format } from 'date-fns';
import { enUS, sl as slLocale } from 'date-fns/locale';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Button, Chip, EmptyState, Loading, Screen, Subtitle } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { useEventsHeader } from '@/contexts/EventsHeaderContext';
import { fetchActivities, clearActivityDecline, declineActivity, joinActivity } from '@/lib/api';
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
  const { setControls } = useEventsHeader();
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [list, setList] = useState<'open' | 'declined'>('open');
  const [openItems, setOpenItems] = useState<ActivityWithRelations[]>([]);
  const [declinedItems, setDeclinedItems] = useState<ActivityWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLoaded = useRef(false);
  const loadedAt = useRef(0);
  const fetchedSearch = useRef<string | null>(null);
  const itemsRef = useRef<ActivityWithRelations[]>([]);
  itemsRef.current = openItems.concat(declinedItems);
  const shown = list === 'declined' ? declinedItems : openItems;

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
          inbox: true,
        });
        setOpenItems(data.open);
        setDeclinedItems(data.declined);
        hasLoaded.current = true;
        loadedAt.current = Date.now();
        fetchedSearch.current = search;
      } catch (e) {
        setError(e instanceof Error ? e.message : t.common.error);
      } finally {
        setLoading(false);
      }
    },
    [userId, configured, search, t.common.error]
  );

  useLayoutEffect(() => {
    setControls({
      search,
      searchOpen,
      onSearchChange: setSearch,
      onSearchOpen: () => setSearchOpen(true),
      onSearchClose: () => {
        setSearchOpen(false);
        setSearch('');
      },
      onSearchSubmit: () => {
        void load();
      },
    });
  }, [search, searchOpen, load, setControls]);

  useEffect(() => () => setControls(null), [setControls]);

  const scheduleLiveReload = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      void load({ silent: true });
    }, 250);
  }, [load]);

  // Drop events from the list the moment they start (without waiting for focus)
  useEffect(() => {
    const now = Date.now();
    const upcoming = openItems.concat(declinedItems);
    const nextStart = upcoming
      .map((a) => new Date(a.starts_at).getTime())
      .filter((t) => t > now)
      .sort((a, b) => a - b)[0];
    if (nextStart == null) return;
    const delay = Math.min(Math.max(nextStart - now + 100, 100), 2_147_483_647);
    const timer = setTimeout(() => {
      const stillAhead = (a: ActivityWithRelations) => new Date(a.starts_at).getTime() > Date.now();
      setOpenItems((prev) => prev.filter(stillAhead));
      setDeclinedItems((prev) => prev.filter(stillAhead));
      void load({ silent: true });
    }, delay);
    return () => clearTimeout(timer);
  }, [openItems, declinedItems, load]);

  useFocusEffect(
    useCallback(() => {
      const stale = Date.now() - loadedAt.current > 15_000;
      const searchChanged = fetchedSearch.current !== search;
      if (!hasLoaded.current || stale || searchChanged) void load();
      if (!userId || !configured) return;

      const touchesFeed = (row: { activity_id?: string; id?: string; series_id?: string; created_by?: string } | null) => {
        if (!row) return false;
        if (row.created_by && row.created_by === userId) return true;
        const activityId = row.activity_id ?? row.id;
        if (!activityId) return false;
        return itemsRef.current.some(
          (a) => a.id === activityId || a.series_id === activityId || a.id === row.series_id
        );
      };

      const onChange = (payload: { new?: Record<string, string | null>; old?: Record<string, string | null> }) => {
        const next = payload.new && (payload.new.id || payload.new.activity_id) ? payload.new : payload.old;
        if (!touchesFeed(next)) return;
        scheduleLiveReload();
      };

      const channel = supabase
        .channel(`events-live-${userId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'activity_joins' }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'activity_declines' }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'activity_guest_attendances' }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'activities' }, onChange)
        .subscribe();

      return () => {
        if (reloadTimer.current) clearTimeout(reloadTimer.current);
        supabase.removeChannel(channel);
      };
    }, [load, search, userId, configured, scheduleLiveReload])
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

  async function onDecline(item: ActivityWithRelations) {
    if (!user) return;
    setBusyId(item.id);
    try {
      if (item.is_declined) await clearActivityDecline(item.id, user.id);
      else await declineActivity(item.id, user.id);
      await load({ silent: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : t.common.error;
      Alert.alert(t.common.error, msg === 'DECLINES_DB' ? t.events.declineDbFix : msg);
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
      {loading && !hasLoaded.current ? (
        <Loading />
      ) : error ? (
        <EmptyState title={error} subtitle={t.common.retry} />
      ) : (
        <View style={styles.listWrap}>
        <View style={styles.tabs}>
          <Chip label={t.events.openList} active={list === 'open'} onPress={() => setList('open')} />
          <Chip
            label={
              declinedItems.length > 0 ? `${t.events.decline} · ${declinedItems.length}` : t.events.decline
            }
            active={list === 'declined'}
            onPress={() => setList('declined')}
          />
        </View>
        <FlatList
          data={shown}
          keyExtractor={(item) => item.id}
          style={styles.list}
          contentContainerStyle={{ paddingBottom: 96, paddingTop: 4, flexGrow: 1 }}
          ListEmptyComponent={
            <EmptyState title={list === 'declined' ? t.events.declinedEmpty : t.events.empty} />
          }
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

                {joined ? null : (
                  <View style={styles.actions} onStartShouldSetResponder={() => true}>
                    <Button
                      label={list === 'declined' ? t.events.undecided : t.events.decline}
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onPress={() => void onDecline(item)}
                    />
                    <Button
                      label={full ? t.events.full : t.events.join}
                      disabled={full || busy}
                      loading={busy}
                      size="sm"
                      icon="check"
                      onPress={() => void onJoin(item)}
                    />
                  </View>
                )}
              </View>
            );
          }}
        />
        </View>
      )}
      <View style={styles.fabWrap} pointerEvents="box-none">
        <Pressable
          onPress={() => router.push('/activity/create')}
          style={({ pressed }) => [styles.fab, pressed ? { opacity: 0.9, transform: [{ scale: 0.96 }] } : null]}
          accessibilityRole="button"
          accessibilityLabel={t.events.create}>
          <FontAwesome name="plus" size={22} color="#fff" />
        </Pressable>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  listWrap: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  tabs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
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
  card: {
    width: '100%',
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
  cardBody: {
    padding: theme.space.md,
    paddingBottom: 10,
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    paddingHorizontal: theme.space.md,
    paddingBottom: theme.space.md,
  },
});
