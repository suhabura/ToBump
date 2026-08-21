import { format } from 'date-fns';
import { enUS } from 'date-fns/locale';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Button, Chip, EmptyState, Loading, Muted, Screen, Subtitle, Title } from '@/components/ui';
import { ActivityFinancePanel } from '@/components/ActivityFinancePanel';
import { useAuth } from '@/contexts/AuthContext';
import {
  deleteActivity,
  joinActivity,
  leaveActivity,
  processDueRecurringActivities,
  userCanEditActivity,
  type DeleteActivityMode,
} from '@/lib/api';
import { formatRecurrence, hydrateRules, rulesFromLegacy } from '@/lib/recurrence';
import { supabase } from '@/lib/supabase';
import type { ActivityWithRelations, Profile } from '@/lib/types';
import { activityLocationLabel, categoryLabel, displayName } from '@/lib/types';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

export default function ActivityDetailScreen() {
  const t = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const router = useRouter();
  const [activity, setActivity] = useState<ActivityWithRelations | null>(null);
  const [participants, setParticipants] = useState<Profile[]>([]);
  const [joined, setJoined] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [tab, setTab] = useState<'details' | 'finance'>('details');

  const load = useCallback(async () => {
    if (!user || !id) return;
    setLoading(true);
    try {
      await processDueRecurringActivities();
    } catch {
      /* RPC morda še ni nameščen */
    }

    // Če je ta instance že zaključena in obstaja naslednja, preusmeri
    const { data: next } = await supabase
      .from('activities')
      .select('id')
      .eq('previous_activity_id', id)
      .eq('status', 'active')
      .maybeSingle();
    if (next?.id && next.id !== id) {
      router.replace(`/activity/${next.id}`);
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
    setJoined(ids.includes(user.id));
    if (ids.length) {
      const { data: people } = await supabase.from('profiles').select('*').in('id', ids);
      setParticipants((people as Profile[]) ?? []);
    } else setParticipants([]);
    setLoading(false);
  }, [id, user?.id, router]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  async function onJoin() {
    if (!user || !activity) return;
    try {
      await joinActivity(activity.id, user.id, activity.created_by, activity.title);
      load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    }
  }

  async function onLeave() {
    if (!user || !activity) return;
    await leaveActivity(activity.id, user.id);
    load();
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
      router.replace('/(tabs)');
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

  if (loading) return <Loading />;
  if (!activity) {
    return (
      <Screen>
        <EmptyState title="Event not found" />
      </Screen>
    );
  }

  const isOwner = user?.id === activity.created_by;
  const full =
    activity.max_participants != null && participants.length >= activity.max_participants;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Title>
          {categoryLabel(activity.categories) ?? `${activity.title} (${t.events.uncategorized})`}
        </Title>

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
        <Muted>
          {format(new Date(activity.starts_at), 'EEEE, d MMMM yyyy · HH:mm', { locale: enUS })}
          {activity.ends_at
            ? ` – ${format(new Date(activity.ends_at), 'HH:mm', { locale: enUS })}`
            : ''}
        </Muted>
        {activity.is_recurring ? (
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
              )
            )}
            {activity.recurrence_until
              ? ` · ${t.form.seriesEnds} ${format(new Date(`${activity.recurrence_until}T12:00:00`), 'd MMM yyyy', { locale: enUS })}`
              : ''}
          </Muted>
        ) : null}
        <Muted>
          {t.events.organizer}: {displayName(activity.profiles)}
        </Muted>
        {(() => {
          const location = activityLocationLabel(activity);
          if (!location) return <Muted>{t.events.locationUnset}</Muted>;
          const ent = activity.enterprises;
          const address = ent?.address?.trim() || (!ent ? activity.venue_text?.trim() : '') || '';
          // Only offer Maps when an actual address was entered (not just a provider name).
          const mapsUrl = address
            ? ent?.latitude != null && ent?.longitude != null
              ? `https://www.google.com/maps?q=${ent.latitude},${ent.longitude}`
              : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                  ent ? `${ent.name}, ${address}` : address
                )}`
            : null;
          return (
            <View>
              <Muted>
                {t.events.location}:{' '}
                {ent ? (
                  <Text
                    style={{ color: theme.colors.primary, fontWeight: '600' }}
                    onPress={() => router.push(`/enterprise/${activity.enterprise_id}`)}>
                    {ent.name}
                  </Text>
                ) : (
                  location
                )}
                {ent?.address ? ` · ${ent.address}` : null}
                {ent
                  ? ent.provider_kind === 'tobump_booking'
                    ? ` · ${t.events.tobumpBooking}`
                    : ` · ${t.events.officialProvider}`
                  : null}
              </Muted>
              {mapsUrl ? (
                <Text style={styles.mapsLink} onPress={() => Linking.openURL(mapsUrl)}>
                  {t.events.openMaps}
                </Text>
              ) : null}
            </View>
          );
        })()}
        <Muted>
          {t.common.price}:{' '}
          {activity.price && Number(activity.price) > 0 ? `${activity.price} €` : t.common.free}
        </Muted>
        <Muted>
          {t.events.participants}: {participants.length}
          {activity.max_participants ? ` / ${activity.max_participants}` : ''}
        </Muted>

        <View style={{ marginTop: 16, gap: 8 }}>
          {joined ? (
            <View style={styles.actionRow}>
              <View style={styles.actionFlex}>
                <Button
                  label={t.events.chat}
                  variant="secondary"
                  onPress={() => router.push(`/chat/${activity.id}`)}
                />
              </View>
              <View style={styles.actionFlex}>
                <Button label={t.events.leave} variant="danger" onPress={onLeave} />
              </View>
            </View>
          ) : (
            <Button
              label={full ? t.events.full : t.events.join}
              onPress={onJoin}
              disabled={full}
            />
          )}
          {canEdit ? (
            <Button
              label={t.events.edit}
              variant="secondary"
              onPress={() => router.push(`/activity/edit/${activity.id}`)}
            />
          ) : null}
          {isOwner ? (
            <>
              {deleteError ? <Text style={styles.deleteError}>{deleteError}</Text> : null}
              <Button label={t.events.delete} variant="danger" onPress={onDelete} loading={deleting} />
            </>
          ) : null}
        </View>

        <View style={{ marginTop: 24 }}>
          <Subtitle>{t.events.participants}</Subtitle>
          {participants.map((p) => (
            <Text key={p.id} style={styles.participant}>
              {displayName(p)}
            </Text>
          ))}
        </View>
          </>
        )}
      </ScrollView>

      <Modal visible={deleteOpen} transparent animationType="fade" onRequestClose={() => setDeleteOpen(false)}>
        <Pressable style={styles.deleteBackdrop} onPress={() => setDeleteOpen(false)}>
          <Pressable style={styles.deleteSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.deleteTitle}>{t.events.delete}</Text>
            <Muted>
              {activity.is_recurring ? t.events.deleteRecurringPrompt : t.events.deleteConfirmPrompt}
            </Muted>
            <View style={{ height: 12 }} />
            {activity.is_recurring ? (
              <>
                <Button
                  label={t.events.deleteThisOnly}
                  variant="secondary"
                  loading={deleting}
                  onPress={() => confirmDelete('occurrence')}
                />
                <View style={{ height: 8 }} />
                <Button
                  label={t.events.deleteSeries}
                  variant="danger"
                  loading={deleting}
                  onPress={() => confirmDelete('series')}
                />
              </>
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  participant: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    color: theme.colors.text,
  },
  mapsLink: {
    color: theme.colors.primary,
    fontWeight: '600',
    marginTop: 4,
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
