import { useEffect, useState } from 'react';
import { Alert, StyleSheet, Switch, Text, View } from 'react-native';
import { Button, Muted, Subtitle } from '@/components/ui';
import { FriendPicker } from '@/components/FriendPicker';
import { createNotification } from '@/lib/api';
import { dedupeProfilesByEmail } from '@/lib/friends';
import { supabase } from '@/lib/supabase';
import type { ActivityWithRelations, Privacy, Profile } from '@/lib/types';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

type Props = {
  activity: ActivityWithRelations;
  userId: string;
  onChanged?: () => void;
};

function basePrivacy(activity: ActivityWithRelations): Privacy {
  const stored = activity.series_privacy;
  if (stored && stored !== 'friends_of_friends') return stored;
  if (activity.privacy && activity.privacy !== 'friends_of_friends') return activity.privacy;
  if (activity.group_id) return 'group';
  return 'invite';
}

/** Organizer opens this occurrence to more people — does not change the series template. */
export function ActivityExtraInvitePanel({ activity, userId, onChanged }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [friends, setFriends] = useState<Profile[]>([]);
  const [inviteIds, setInviteIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [fofBusy, setFofBusy] = useState(false);
  const fofOn = activity.privacy === 'friends_of_friends';

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const { data: fr } = await supabase
          .from('friendships')
          .select('*')
          .eq('status', 'accepted')
          .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`);
        const otherIds = Array.from(
          new Set(
            (fr ?? []).map((f: { from_user_id: string; to_user_id: string }) =>
              f.from_user_id === userId ? f.to_user_id : f.from_user_id
            )
          )
        );
        if (!otherIds.length) {
          setFriends([]);
          return;
        }
        const { data: profiles } = await supabase.from('profiles').select('*').in('id', otherIds);
        setFriends(dedupeProfilesByEmail((profiles as Profile[]) ?? []));
      } catch {
        setFriends([]);
      }
    })();
  }, [open, userId]);

  async function setParticipantsFriends(on: boolean) {
    setFofBusy(true);
    try {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (on) {
        patch.privacy = 'friends_of_friends';
        if (!activity.series_privacy) {
          patch.series_privacy = basePrivacy(activity);
        }
      } else {
        patch.privacy = basePrivacy(activity);
      }
      const { error } = await supabase.from('activities').update(patch).eq('id', activity.id);
      if (error) {
        if (/activities_privacy_check|friends_of_friends/i.test(error.message ?? '')) {
          throw new Error(t.form.fofDbFix);
        }
        throw error;
      }
      onChanged?.();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setFofBusy(false);
    }
  }

  async function submit() {
    const unique = Array.from(new Set(inviteIds.filter((id) => id !== userId)));
    if (!unique.length) {
      Alert.alert(t.common.error, t.form.needInviteFriends);
      return;
    }
    setBusy(true);
    try {
      const rows = unique.map((uid) => ({
        activity_id: activity.id,
        user_id: uid,
        invited_by: userId,
      }));
      const { error: invErr } = await supabase
        .from('activity_invites')
        .upsert(rows, { onConflict: 'activity_id,user_id' });
      if (invErr) throw invErr;
      void Promise.all(
        unique.map((uid) =>
          createNotification(uid, 'invite', `Invite to event: ${activity.title}`, {
            activity_id: activity.id,
          })
        )
      );
      Alert.alert(t.common.ok, t.events.extraInviteDone);
      setInviteIds([]);
      onChanged?.();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 10, marginTop: 16 }}>
      <View style={styles.headerRow}>
        <Subtitle>{t.events.extraInviteNeedPeople}</Subtitle>
        {open ? (
          <Text style={styles.link} onPress={() => setOpen(false)}>
            {t.common.cancel}
          </Text>
        ) : null}
      </View>
      <Muted>{fofOn ? t.events.extraInviteFofOn : t.events.extraInviteStatusInvite}</Muted>
      {!open ? (
        <Button
          label={t.events.extraInviteOpenDate}
          variant="secondary"
          size="sm"
          onPress={() => setOpen(true)}
        />
      ) : (
        <View style={{ gap: 12 }}>
          <Muted>{t.events.extraInviteFofHint}</Muted>
          <View style={styles.setting}>
            <Text style={styles.settingLabel}>{t.events.friendsOfFriends}</Text>
            <Switch
              value={fofOn}
              disabled={fofBusy}
              onValueChange={(v) => void setParticipantsFriends(v)}
              trackColor={{ true: theme.colors.primary, false: theme.colors.border }}
            />
          </View>
          <Text style={styles.moreLabel}>{t.events.extraInviteMorePeople}</Text>
          <FriendPicker
            friends={friends}
            selectedIds={inviteIds}
            onChange={setInviteIds}
            label={t.form.selectFriends}
            placeholder={t.form.searchFriends}
            emptyHint={t.form.noFriends}
          />
          <Button label={t.events.extraInviteApply} loading={busy} onPress={() => void submit()} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  link: { color: theme.colors.primary, fontWeight: '600', fontSize: 14 },
  setting: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 8,
  },
  settingLabel: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  moreLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.colors.text,
  },
});
