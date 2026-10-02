import { format } from 'date-fns';
import { enUS, sl as slLocale } from 'date-fns/locale';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { DateTimeField } from '@/components/DateTimeField';
import { showToast } from '@/components/Toast';
import { WeatherBadge } from '@/components/WeatherBadge';
import { Button, Chip, EmptyState, Loading, Muted, Screen, Title } from '@/components/ui';
import { ActivityExtraInvitePanel } from '@/components/ActivityExtraInvitePanel';
import { ActivityFinancePanel } from '@/components/ActivityFinancePanel';
import { ActivityGuestsPanel } from '@/components/ActivityGuestsPanel';
import { useAuth } from '@/contexts/AuthContext';
import {
  clearActivityDecline,
  declineActivity,
  ensureDueRecurringActivities,
  deleteActivity,
  fetchSeriesOptOuts,
  joinActivity,
  leaveActivity,
  markSeriesDeclinePrompted,
  optOutOfSeries,
  rescheduleOccurrence,
  userCanEditActivity,
  type DeleteActivityMode,
} from '@/lib/api';
import { fetchActivityGuests, removeGuestAttendance, type GuestAttendanceWithGuest } from '@/lib/guests';
import { formatRecurrence, formatRecurrenceDates, hydrateRules, isSeriesActivity, localDayKey, rulesFromLegacy } from '@/lib/recurrence';
import { seriesKey } from '@/lib/finance';
import { fetchSeriesFollows, fetchSkippedDays, markSeriesDaySkipped, setSeriesFollow } from '@/lib/seriesPlanner';
import { supabase } from '@/lib/supabase';
import type { ActivityWithRelations, Profile } from '@/lib/types';
import { activityPriceLabel, activityVenuePoint, displayName } from '@/lib/types';
import { eventWeatherPoint } from '@/lib/weather';
import { mapsUrl } from '@/lib/geo';
import { useLocale, useT } from '@/i18n';
import { theme } from '@/constants/theme';

function byName(people: Profile[]): Profile[] {
  return [...people].sort((a, b) => displayName(a).localeCompare(displayName(b), 'sl'));
}

function signupSummary(
  count: number,
  activity: { min_participants?: number | null; max_participants?: number | null },
  labels: {
    signedUpOf: (count: number, max: number) => string;
    signedUpRange: (count: number, min: number, max: number) => string;
    signedUpMin: (count: number, min: number) => string;
    signedUpOnly: (count: number) => string;
  }
): string {
  const min = activity.min_participants ?? null;
  const max = activity.max_participants ?? null;
  if (min != null && max != null && min !== max) return labels.signedUpRange(count, min, max);
  if (max != null) return labels.signedUpOf(count, max);
  if (min != null) return labels.signedUpMin(count, min);
  return labels.signedUpOnly(count);
}

function ResponseGroup({ title, people }: { title: string; people: Profile[] }) {
  return (
    <View style={styles.responseGroup}>
      <Text style={styles.responseTitle}>
        {title} · {people.length}
      </Text>
      {people.map((person) => (
        <Text key={person.id} style={styles.responseName}>
          {displayName(person)}
        </Text>
      ))}
    </View>
  );
}

export default function ActivityDetailScreen() {
  const t = useT();
  const { locale } = useLocale();
  const dfLocale = locale === 'sl' ? slLocale : enUS;
  const { id, tab: tabParam } = useLocalSearchParams<{ id: string; tab?: string | string[] }>();
  const financeTab =
    (Array.isArray(tabParam) ? tabParam[0] : tabParam) === 'finance' ? 'finance' : null;
  const { user } = useAuth();
  const router = useRouter();
  const [activity, setActivity] = useState<ActivityWithRelations | null>(null);
  const [participants, setParticipants] = useState<Profile[]>([]);
  const [decliners, setDecliners] = useState<Profile[]>([]);
  const [silent, setSilent] = useState<Profile[]>([]);
  const [declined, setDeclined] = useState(false);
  const [seriesOptedOut, setSeriesOptedOut] = useState(false);
  const [seriesPrompted, setSeriesPrompted] = useState(false);
  const [declineChoiceOpen, setDeclineChoiceOpen] = useState(false);
  const [guests, setGuests] = useState<GuestAttendanceWithGuest[]>([]);
  const [joined, setJoined] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveStart, setMoveStart] = useState<Date | null>(null);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLoaded = useRef(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [tab, setTab] = useState<'details' | 'finance'>(financeTab ?? 'details');
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [following, setFollowing] = useState(false);
  const [dateSkipped, setDateSkipped] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [seriesBusy, setSeriesBusy] = useState(false);
  const routeKey = Array.isArray(id) ? id[0] : (id ?? '');
  const routeKeyRef = useRef(routeKey);
  routeKeyRef.current = routeKey;
  const [seenRouteId, setSeenRouteId] = useState(routeKey);
  if (seenRouteId !== routeKey) {
    setSeenRouteId(routeKey);
    setJoined(false);
    setFollowing(false);
    setDateSkipped(false);
    setActivity(null);
    setLoading(true);
  }

  useEffect(() => {
    setTab(financeTab ?? 'details');
  }, [id, financeTab]);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!user || !id) return;
    const startedFor = Array.isArray(id) ? id[0] : id;
    if (!opts?.silent || !hasLoaded.current) {
      setLoading(true);
    }
    void ensureDueRecurringActivities();

    // Če je ta instance že zaključena in obstaja naslednja, preusmeri
    const { data: next } = await supabase
      .from('activities')
      .select('id')
      .eq('previous_activity_id', id)
      .eq('status', 'active')
      .maybeSingle();
    const { data: openedRow } = await supabase
      .from('activities')
      .select('starts_at, ends_at, status')
      .eq('id', startedFor)
      .maybeSingle();
    const endMs = openedRow?.ends_at ? new Date(openedRow.ends_at).getTime() : NaN;
    const startMs = openedRow?.starts_at ? new Date(openedRow.starts_at).getTime() : NaN;
    const occurrenceOver =
      openedRow?.status === 'completed' ||
      (!Number.isNaN(endMs) ? endMs <= Date.now() : !Number.isNaN(startMs) && startMs <= Date.now());
    if (next?.id && next.id !== id && occurrenceOver) {
      router.replace({
        pathname: '/activity/[id]',
        params: {
          id: next.id,
          ...(financeTab || tabRef.current === 'finance' ? { tab: 'finance' } : {}),
        },
      });
      return;
    }

    const { data, error } = await supabase
      .from('activities')
      .select(
        '*, profiles:created_by(id, first_name, last_name, avatar_url), categories(id, name, icon, parent_id), enterprises(id, name, address, provider_kind, latitude, longitude)'
      )
      .eq('id', id)
      .maybeSingle();

    let row = data;
    if (error) {
      const retry = await supabase
        .from('activities')
        .select(
          '*, profiles:created_by(id, first_name, last_name, avatar_url), categories(id, name, icon), enterprises(id, name, address, provider_kind, latitude, longitude)'
        )
        .eq('id', id)
        .maybeSingle();
      row = retry.data;
    }

    let act = (row as ActivityWithRelations) ?? null;
    if (act?.categories && (act.categories as { parent_id?: string | null }).parent_id) {
      const parentId = (act.categories as { parent_id: string }).parent_id;
      const { data: parent } = await supabase
        .from('categories')
        .select('id, name')
        .eq('id', parentId)
        .maybeSingle();
      if (parent) {
        act = {
          ...act,
          categories: { ...act.categories!, parent: parent as { id: string; name: string } },
        };
      }
    }
    setActivity(act);
    if (row) {
      const access = await userCanEditActivity(id, user.id);
      setCanEdit(access.canEdit);
    } else {
      setCanEdit(false);
    }

    const { data: joins } = await supabase.from('activity_joins').select('user_id').eq('activity_id', id);
    const ids = (joins ?? []).map((j: { user_id: string }) => j.user_id);
    const joinedNow = ids.includes(user.id);
    const joinedSet = new Set(ids);
    setJoined(joinedNow);
    if (ids.length) {
      const { data: people } = await supabase.from('profiles').select('*').in('id', ids);
      setParticipants(byName((people as Profile[]) ?? []));
    } else setParticipants([]);

    const { data: declineRows, error: declineErr } = await supabase
      .from('activity_declines')
      .select('user_id')
      .eq('activity_id', id);
    let declineIds: string[] = [];
    if (declineErr) {
      setDecliners([]);
      setDeclined(false);
    } else {
      declineIds = (declineRows ?? [])
        .map((d: { user_id: string }) => d.user_id)
        .filter((uid: string) => !joinedSet.has(uid));
      setDeclined(!joinedNow && declineIds.includes(user.id));
      if (declineIds.length) {
        const { data: people } = await supabase.from('profiles').select('*').in('id', declineIds);
        setDecliners(byName((people as Profile[]) ?? []));
      } else setDecliners([]);
    }

    const declinedSet = new Set(declineIds);
    const { data: inviteRows, error: inviteErr } = await supabase
      .from('activity_invites')
      .select('user_id')
      .eq('activity_id', id);
    if (inviteErr || !inviteRows) {
      setSilent([]);
    } else {
      const silentIds = Array.from(
        new Set(
          (inviteRows as { user_id: string }[])
            .map((row) => row.user_id)
            .filter((uid) => !joinedSet.has(uid) && !declinedSet.has(uid))
        )
      );
      if (silentIds.length) {
        const { data: people } = await supabase.from('profiles').select('*').in('id', silentIds);
        setSilent(byName((people as Profile[]) ?? []));
      } else setSilent([]);
    }

    try {
      setGuests(await fetchActivityGuests(id));
    } catch {
      setGuests([]);
    }
    if (act && user) {
      const sid = seriesKey(act);
      try {
        const followSet = await fetchSeriesFollows(user.id);
        setFollowing(followSet.has(sid));
      } catch {
        setFollowing(false);
      }
      try {
        const day = localDayKey(new Date(act.starts_at));
        const skipped = await fetchSkippedDays([sid]);
        setDateSkipped(skipped.get(sid)?.has(day) ?? false);
      } catch {
        setDateSkipped(false);
      }
      try {
        const optOuts = await fetchSeriesOptOuts(user.id);
        const opted = optOuts.has(sid);
        setSeriesOptedOut(opted);
        if (opted) {
          setSeriesPrompted(true);
        } else {
          const { data: promptRow, error: promptErr } = await supabase
            .from('series_decline_prompts')
            .select('series_id')
            .eq('series_id', sid)
            .eq('user_id', user.id)
            .maybeSingle();
          if (promptErr) setSeriesPrompted(false);
          else setSeriesPrompted(Boolean(promptRow));
        }
      } catch {
        setSeriesOptedOut(false);
        setSeriesPrompted(false);
      }
    } else {
      setFollowing(false);
      setDateSkipped(false);
      setSeriesOptedOut(false);
      setSeriesPrompted(false);
    }
    if (routeKeyRef.current !== startedFor) return;
    hasLoaded.current = true;
    setLoading(false);
  }, [id, user?.id, router, financeTab]);

  useFocusEffect(
    useCallback(() => {
      void load();
      if (!id) return;

      const refreshIfMine = (payload: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
        const row = payload.new?.activity_id ? payload.new : payload.old;
        if (row?.activity_id !== id) return;
        if (reloadTimer.current) clearTimeout(reloadTimer.current);
        reloadTimer.current = setTimeout(() => void load({ silent: true }), 200);
      };

      const channel = supabase
        .channel(`activity-live-${id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'activity_joins' }, refreshIfMine)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'activity_declines' }, refreshIfMine)
        .subscribe();

      const rowChannel = supabase
        .channel(`activity-row-${id}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'activities', filter: `id=eq.${id}` },
          () => {
            if (reloadTimer.current) clearTimeout(reloadTimer.current);
            reloadTimer.current = setTimeout(() => void load({ silent: true }), 200);
          }
        )
        .subscribe();

      const followChannel = user?.id
        ? supabase
            .channel(`activity-follow-${user.id}`)
            .on(
              'postgres_changes',
              { event: '*', schema: 'public', table: 'series_follows', filter: `user_id=eq.${user.id}` },
              () => {
                if (reloadTimer.current) clearTimeout(reloadTimer.current);
                reloadTimer.current = setTimeout(() => void load({ silent: true }), 200);
              }
            )
            .subscribe()
        : null;

      return () => {
        if (reloadTimer.current) clearTimeout(reloadTimer.current);
        supabase.removeChannel(channel);
        supabase.removeChannel(rowChannel);
        if (followChannel) supabase.removeChannel(followChannel);
      };
    }, [load, id, user?.id])
  );

  async function onJoin() {
    if (!user || !activity) return;
    try {
      await joinActivity(activity.id, user.id, activity.created_by, activity.title);
      void load({ silent: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : t.common.error;
      Alert.alert(t.common.error, /full/i.test(msg) ? t.events.eventFull : msg);
      void load({ silent: true });
    }
  }

  async function onNotGoing() {
    if (!user || !activity) return;
    try {
      if (joined) {
        await leaveActivity(activity.id, user.id);
        void load({ silent: true });
        return;
      }
      if (declined) {
        await clearActivityDecline(activity.id, user.id);
        void load({ silent: true });
        return;
      }
      if (
        isSeriesActivity(activity) &&
        !seriesOptedOut &&
        !seriesPrompted
      ) {
        setDeclineChoiceOpen(true);
        return;
      }
      await declineActivity(activity.id, user.id);
      void load({ silent: true });
    } catch (e) {
      void load({ silent: true });
      const msg = e instanceof Error ? e.message : t.common.error;
      Alert.alert(
        t.common.error,
        msg === 'DECLINES_DB'
          ? t.events.declineDbFix
          : msg === 'OPT_OUT_DB'
            ? t.events.optOutDbFix
            : msg
      );
    }
  }

  async function onDeclineThisDate() {
    if (!user || !activity) return;
    setDeclineChoiceOpen(false);
    try {
      await declineActivity(activity.id, user.id);
      await markSeriesDeclinePrompted(activity.id, user.id);
      void load({ silent: true });
    } catch (e) {
      void load({ silent: true });
      const msg = e instanceof Error ? e.message : t.common.error;
      Alert.alert(
        t.common.error,
        msg === 'DECLINES_DB'
          ? t.events.declineDbFix
          : msg === 'OPT_OUT_DB'
            ? t.events.optOutDbFix
            : msg
      );
    }
  }

  async function onDeclineNeverSeries() {
    if (!user || !activity) return;
    setDeclineChoiceOpen(false);
    try {
      await optOutOfSeries(activity.id, user.id);
      void load({ silent: true });
    } catch (e) {
      void load({ silent: true });
      const msg = e instanceof Error ? e.message : t.common.error;
      Alert.alert(
        t.common.error,
        msg === 'DECLINES_DB'
          ? t.events.declineDbFix
          : msg === 'OPT_OUT_DB'
            ? t.events.optOutDbFix
            : msg
      );
    }
  }

  async function onNeverComing() {
    if (!user || !activity) return;
    try {
      await optOutOfSeries(activity.id, user.id);
      void load({ silent: true });
    } catch (e) {
      void load({ silent: true });
      const msg = e instanceof Error ? e.message : t.common.error;
      Alert.alert(
        t.common.error,
        msg === 'DECLINES_DB'
          ? t.events.declineDbFix
          : msg === 'OPT_OUT_DB'
            ? t.events.optOutDbFix
            : msg
      );
    }
  }

  async function onDelete() {
    if (!activity) return;
    setDeleteError(null);
    setDeleteOpen(true);
  }

  async function confirmDelete(mode: DeleteActivityMode) {
    if (!activity) return;
    setDeleting(true);
    setDeleteError(null);
    setDeleteOpen(false);
    try {
      await deleteActivity(activity.id, mode);
      if (router.canGoBack()) router.back();
      else router.replace('/(tabs)');
    } catch (e) {
      const msg =
        e instanceof Error && e.message && !/could not delete/i.test(e.message)
          ? e.message
          : t.events.deleteFailed;
      setDeleteError(msg);
      Alert.alert(t.common.error, msg);
    } finally {
      setDeleting(false);
    }
  }

  async function onSkipDate() {
    if (!activity || !user || skipping || dateSkipped) return;
    setSkipping(true);
    try {
      const sid = seriesKey(activity);
      const starts = new Date(activity.starts_at);
      const day = localDayKey(starts);
      const fresh = await markSeriesDaySkipped(sid, day);
      if (fresh) {
        const { data: joins, error: joinsError } = await supabase
          .from('activity_joins')
          .select('user_id')
          .eq('activity_id', activity.id);
        if (joinsError) throw joinsError;
        const dateLabel = format(starts, 'd. M. yyyy', { locale: dfLocale });
        const message = t.planner.skippedNotice(activity.title, dateLabel);
        const ids = ((joins ?? []) as { user_id: string }[])
          .map((row) => row.user_id)
          .filter((uid) => uid && uid !== user.id);
        await Promise.all(
          ids.map(async (uid) => {
            const { error } = await supabase.rpc('notify_user', {
              p_user_id: uid,
              p_type: 'series_skipped',
              p_message: message,
              p_data: { activity_id: activity.id },
            });
            if (error) {
              await supabase.from('notifications').insert({
                user_id: uid,
                type: 'series_skipped',
                message,
                data: { activity_id: activity.id },
              });
            }
          })
        );
      }
      setDateSkipped(true);
      showToast(t.planner.skipped);
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setSkipping(false);
    }
  }

  if (loading) return <Loading />;
  if (!activity) {
    return (
      <Screen>
        <EmptyState title={t.events.notFound} />
      </Screen>
    );
  }

  const isOwner = user?.id === activity.created_by;
  const showJoin = !joined && !dateSkipped;
  const showDecline = !dateSkipped && (joined || !declined);
  const showNever = Boolean(user && isSeriesActivity(activity) && !seriesOptedOut);
  const showPlanner = Boolean(user && isSeriesActivity(activity));
  const participantCount = participants.length + guests.length;
  const signupLine = signupSummary(participantCount, activity, t.events);
  const weather = eventWeatherPoint(activity);
  const place = activity.enterprises;
  const placeName = place?.name ?? activity.venue_text?.trim() ?? null;
  const placeAddress = place?.address?.trim() || null;
  const placePoint = activityVenuePoint(activity);
  const mapsLink = placePoint
    ? mapsUrl(placePoint)
    : placeAddress
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
          `${place?.name ?? ''}, ${placeAddress}`
        )}`
      : null;
  const provider = place
    ? place.provider_kind === 'tobump_booking'
      ? t.events.tobumpBooking
      : t.events.officialProvider
    : null;
  const full =
    activity.max_participants != null && participantCount >= activity.max_participants;

  async function onRemoveGuest(attendanceId: string) {
    try {
      await removeGuestAttendance(attendanceId);
      await load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    }
  }

  async function onToggleFollow() {
    if (!activity || !user) return;
    setSeriesBusy(true);
    try {
      await setSeriesFollow(seriesKey(activity), !following);
      setFollowing(!following);
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setSeriesBusy(false);
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={styles.titleRow}>
          <View style={styles.titleMain}>
            <Title>{activity.title}</Title>
          </View>
          {weather ? (
            <WeatherBadge
              inline
              latitude={weather.latitude}
              longitude={weather.longitude}
              startsAt={activity.starts_at}
            />
          ) : null}
        </View>
        {dateSkipped ? (
          <View style={styles.skipBanner}>
            <Text style={styles.skipBannerText}>{t.planner.skipped}</Text>
          </View>
        ) : null}

        {activity.finance_enabled ? (
          <View style={styles.tabRow}>
            <Chip
              label={t.finance.details}
              active={tab === 'details'}
              onPress={() => setTab('details')}
            />
            <Chip
              label={t.finance.tab}
              active={tab === 'finance'}
              onPress={() => setTab('finance')}
            />
          </View>
        ) : null}

        {tab === 'finance' && activity.finance_enabled && user ? (
          <ActivityFinancePanel
            activity={activity}
            userId={user.id}
            canManage={isOwner || canEdit}
            attendees={participants}
          />
        ) : (
          <>
        <Text style={styles.when}>
          {format(new Date(activity.starts_at), 'EEEE, d MMMM yyyy · HH:mm', { locale: dfLocale })}
          {activity.ends_at
            ? ` – ${format(new Date(activity.ends_at), 'HH:mm', { locale: dfLocale })}`
            : ''}
        </Text>
        {(activity.recurrence_dates?.length ?? 0) >= 2 ? (
          <Muted>
            {t.events.dates}: {formatRecurrenceDates(activity.recurrence_dates ?? [], locale)}
          </Muted>
        ) : activity.is_recurring ? (
          <Muted>
            {t.events.recurring}:{' '}
            {formatRecurrence(
              hydrateRules(
                activity.recurrence_rules?.length
                  ? activity.recurrence_rules
                  : rulesFromLegacy(
                      activity.recurrence_weekdays ?? [],
                      new Date(activity.starts_at).getHours(),
                      new Date(activity.starts_at).getMinutes(),
                      activity.duration_minutes ?? 90
                    ),
                activity.duration_minutes ?? 90
              ),
              locale
            )}
            {activity.recurrence_until
              ? ` · ${t.form.seriesEnds} ${format(new Date(`${activity.recurrence_until}T12:00:00`), 'd MMM yyyy', { locale: dfLocale })}`
              : ''}
          </Muted>
        ) : null}
        {activity.profiles ? (
          <View style={styles.factBlock}>
            <Text style={styles.factLabel}>{t.events.organizer}</Text>
            <Text style={styles.factValue}>{displayName(activity.profiles)}</Text>
          </View>
        ) : null}
        {placeName || mapsLink ? (
          <View style={styles.factBlock}>
            <Text style={styles.factLabel}>{t.events.where}</Text>
            {placeName ? (
              place ? (
                <Text
                  style={styles.placeLink}
                  onPress={() => router.push(`/enterprise/${activity.enterprise_id}`)}>
                  {place.name}
                </Text>
              ) : (
                <Text style={styles.factValue}>{placeName}</Text>
              )
            ) : null}
            {placeAddress ? <Muted>{placeAddress}</Muted> : null}
            {provider ? <Muted>{provider}</Muted> : null}
            {mapsLink ? (
              <Text style={styles.placeLink} onPress={() => Linking.openURL(mapsLink)}>
                {t.events.openMaps}
              </Text>
            ) : null}
          </View>
        ) : null}
        {activity.finance_enabled && activity.price != null ? (
          <Muted>
            {t.common.price}: {activityPriceLabel(activity, t.common)}
          </Muted>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t.events.attendanceHeading}</Text>
          <View style={styles.action}>
            <Text style={styles.signupLine}>{signupLine}</Text>
            {showJoin && full && activity.max_participants != null ? (
              <Muted>
                {t.events.fullHint} {participantCount}/{activity.max_participants}
              </Muted>
            ) : null}
            {showJoin ? (
              <Button
                label={full ? t.events.full : t.events.join}
                icon="check"
                onPress={onJoin}
                disabled={full}
              />
            ) : null}
            {showDecline ? (
              <Button
                label={t.events.declineThisDate}
                variant="secondary"
                icon="times"
                onPress={() => void onNotGoing()}
              />
            ) : null}
          </View>
        </View>

        {showPlanner || showNever ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t.events.optionsHeading}</Text>
            {showPlanner ? (
              <View style={styles.action}>
                <Muted>{following ? t.planner.unfollowHint : t.planner.followHint}</Muted>
                <Button
                  label={following ? t.planner.unfollowSeries : t.planner.followSeries}
                  variant="secondary"
                  loading={seriesBusy}
                  onPress={() => void onToggleFollow()}
                />
              </View>
            ) : null}
            {showNever ? (
              <View style={styles.action}>
                <Muted>{t.events.optOutHint}</Muted>
                <Button
                  label={t.events.neverComing}
                  variant="secondary"
                  onPress={() => void onNeverComing()}
                />
              </View>
            ) : null}
          </View>
        ) : null}
        {canEdit || isOwner ? (
          <View style={styles.manageSection}>
            <Text style={styles.sectionTitle}>{t.events.manageHeading}</Text>
            <View style={styles.manageRow}>
              {canEdit ? (
                <View style={styles.primarySlot}>
                  <Button
                    label={isSeriesActivity(activity) ? t.events.editSeries : t.events.edit}
                    variant="outline"
                    size="sm"
                    icon="pencil"
                    onPress={() => router.push(`/activity/edit/${activity.id}`)}
                  />
                </View>
              ) : null}
              {canEdit && isSeriesActivity(activity) ? (
                <View style={styles.primarySlot}>
                  <Button
                    label={t.events.moveTitle}
                    variant="outline"
                    size="sm"
                    icon="calendar"
                    onPress={() => {
                      setMoveError(null);
                      setMoveStart(new Date(activity.starts_at));
                      setMoveOpen(true);
                    }}
                  />
                </View>
              ) : null}
              {isOwner ? (
                <View style={styles.primarySlot}>
                  <Button
                    label={t.events.delete}
                    variant="dangerOutline"
                    size="sm"
                    icon="trash"
                    onPress={onDelete}
                    loading={deleting}
                  />
                </View>
              ) : null}
            </View>
            {canEdit && isSeriesActivity(activity) && !dateSkipped ? (
              <View style={styles.action}>
                <Muted>{t.planner.skipHint}</Muted>
                <Button
                  label={t.planner.skipOccurrence}
                  variant="dangerOutline"
                  icon="ban"
                  loading={skipping}
                  onPress={() => void onSkipDate()}
                />
              </View>
            ) : null}
          </View>
        ) : null}
        {deleteError ? <Text style={styles.deleteError}>{deleteError}</Text> : null}

        <View style={styles.responses}>
          <Text style={styles.sectionTitle}>{t.events.participants}</Text>
          <View style={styles.responseGroup}>
            <Text style={styles.responseTitle}>
              {t.events.coming} · {participants.length + guests.length}
            </Text>
            {participants.map((person) => (
              <Text key={person.id} style={styles.responseName}>
                {displayName(person)}
              </Text>
            ))}
            {guests.map((g) => {
              const gName = g.activity_guests?.name ?? '—';
              return (
                <View key={g.id} style={styles.guestRow}>
                  <Text style={styles.guestName}>
                    {gName} <Text style={styles.guestTag}>({t.guests.guest})</Text>
                  </Text>
                  {isOwner || canEdit ? (
                    <Pressable onPress={() => onRemoveGuest(g.id)}>
                      <Text style={styles.guestRemove}>{t.guests.remove}</Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
          </View>
          <ResponseGroup title={t.events.decline} people={decliners} />
          <ResponseGroup title={t.events.noReply} people={silent} />
          <ActivityGuestsPanel
            activity={activity}
            canManage={isOwner || canEdit}
            guestsOnEvent={guests}
            onChanged={load}
          />
        </View>

        {canEdit && user ? (
          <ActivityExtraInvitePanel
            activity={activity}
            userId={user.id}
            onChanged={() => void load({ silent: true })}
          />
        ) : null}
          </>
        )}
      </ScrollView>

      <Modal visible={moveOpen} transparent animationType="fade" onRequestClose={() => setMoveOpen(false)}>
        <Pressable style={styles.deleteBackdrop} onPress={() => !moving && setMoveOpen(false)}>
          <Pressable style={styles.deleteSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.deleteTitle}>{t.events.moveTitle}</Text>
            <Muted>{t.events.moveHint}</Muted>
            <View style={{ height: 12 }} />
            <DateTimeField
              label={t.form.start}
              value={moveStart}
              onChange={setMoveStart}
              minimumDate={new Date()}
            />
            {moveError ? <Text style={styles.deleteError}>{moveError}</Text> : null}
            <Button
              label={t.events.save}
              loading={moving}
              onPress={() => {
                if (!moveStart || moving) return;
                setMoving(true);
                setMoveError(null);
                void rescheduleOccurrence(activity.id, moveStart)
                  .then(async () => {
                    setMoveOpen(false);
                    await load();
                  })
                  .catch((e: unknown) => {
                    setMoveError(e instanceof Error ? e.message : t.events.moveFailed);
                  })
                  .finally(() => setMoving(false));
              }}
            />
            <View style={{ height: 8 }} />
            <Button label={t.common.cancel} variant="ghost" disabled={moving} onPress={() => setMoveOpen(false)} />
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={deleteOpen} transparent animationType="fade" onRequestClose={() => setDeleteOpen(false)}>
        <Pressable style={styles.deleteBackdrop} onPress={() => setDeleteOpen(false)}>
          <Pressable style={styles.deleteSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.deleteTitle}>
              {activity.is_recurring ? t.events.deleteChoiceTitle : t.events.delete}
            </Text>
            {activity.is_recurring ? null : <Muted>{t.events.deleteConfirmPrompt}</Muted>}
            <View style={{ height: 12 }} />
            {activity.is_recurring ? (
              <View style={styles.deleteChoices}>
                <View style={styles.action}>
                  <Muted>{t.events.deleteThisOnlyHint}</Muted>
                  <Button
                    label={t.events.deleteThisOnly}
                    variant="secondary"
                    loading={deleting}
                    onPress={() => confirmDelete('occurrence')}
                  />
                </View>
                <View style={styles.action}>
                  <Muted>{t.events.deleteSeriesHint}</Muted>
                  <Button
                    label={t.events.deleteSeries}
                    variant="danger"
                    loading={deleting}
                    onPress={() => confirmDelete('series')}
                  />
                </View>
              </View>
            ) : (
              <Button
                label={t.events.delete}
                variant="danger"
                loading={deleting}
                onPress={() => confirmDelete('series')}
              />
            )}
            <View style={{ height: 8 }} />
            <Button label={t.common.cancel} variant="ghost" onPress={() => setDeleteOpen(false)} />
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={declineChoiceOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setDeclineChoiceOpen(false)}>
        <Pressable style={styles.deleteBackdrop} onPress={() => setDeclineChoiceOpen(false)}>
          <Pressable style={styles.deleteSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.deleteTitle}>{t.events.decline}</Text>
            <Muted>{t.events.declineSeriesPrompt}</Muted>
            <View style={{ height: 12 }} />
            <Button
              label={t.events.declineThisDate}
              variant="secondary"
              onPress={() => void onDeclineThisDate()}
            />
            <View style={{ height: 8 }} />
            <Button
              label={t.events.declineNeverSeries}
              variant="secondary"
              onPress={() => void onDeclineNeverSeries()}
            />
            <View style={{ height: 8 }} />
            <Button
              label={t.common.cancel}
              variant="ghost"
              onPress={() => setDeclineChoiceOpen(false)}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  titleMain: {
    flex: 1,
  },
  factBlock: {
    marginTop: 10,
    gap: 2,
  },
  factLabel: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: '700',
  },
  factValue: {
    color: theme.colors.text,
    fontSize: 15,
  },
  section: {
    marginTop: 20,
    gap: 16,
  },
  action: {
    gap: 4,
  },
  deleteChoices: {
    gap: 16,
  },
  manageSection: {
    marginTop: 20,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    gap: 8,
  },
  sectionTitle: {
    color: theme.colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
  },
  signupLine: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  when: {
    color: theme.colors.primaryDark,
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 20,
    marginBottom: 4,
  },
  factLine: {
    color: theme.colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 4,
  },
  placeLink: {
    color: theme.colors.primary,
    fontWeight: '600',
  },
  primaryRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
  },
  primarySlot: {
    flex: 1,
  },
  stack: {
    gap: 8,
    marginTop: 8,
  },
  manageRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  skipBanner: {
    marginTop: 12,
    backgroundColor: theme.colors.danger,
    borderRadius: theme.radius.md,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  skipBannerText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  responses: {
    marginTop: 24,
    gap: 16,
  },
  responseGroup: {
    gap: 2,
  },
  responseTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 4,
    color: theme.colors.text,
  },
  responseName: {
    fontSize: 15,
    lineHeight: 22,
    color: theme.colors.text,
  },
  guestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  guestName: {
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
    color: theme.colors.text,
  },
  guestTag: {
    color: theme.colors.textMuted,
    fontWeight: '600',
  },
  guestRemove: {
    color: theme.colors.danger,
    fontWeight: '600',
    fontSize: 13,
  },
  mapsLink: {
    color: theme.colors.primary,
    fontWeight: '600',
    marginTop: 4,
  },
  declineLink: {
    textAlign: 'center',
    color: theme.colors.textMuted,
    fontSize: 15,
    fontWeight: '600',
    paddingVertical: 4,
  },
  declineOn: {
    color: theme.colors.primaryDark,
  },
  tabRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
    marginBottom: 12,
  },
  deleteBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: 24,
  },
  deleteSheet: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: 20,
  },
  deleteTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: 8,
  },
  deleteError: {
    color: theme.colors.danger,
    marginBottom: 8,
    fontWeight: '600',
  },
  actionRow: { flexDirection: 'row', gap: 8 },
  actionFlex: { flex: 1 },
});
