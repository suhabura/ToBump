import { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Button, Chip, Muted, Subtitle } from '@/components/ui';
import { FriendPicker } from '@/components/FriendPicker';
import { createNotification } from '@/lib/api';
import { dedupeProfilesByEmail } from '@/lib/friends';
import { supabase } from '@/lib/supabase';
import type { ActivityWithRelations, Privacy, Profile } from '@/lib/types';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

type ExtraMode = 'invite' | 'group' | 'friends' | 'friends_of_friends';

type Props = {
  activity: ActivityWithRelations;
  userId: string;
  onChanged?: () => void;
};

/** Organizer opens this occurrence to more people — does not change the series template. */
export function ActivityExtraInvitePanel({ activity, userId, onChanged }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ExtraMode>('invite');
  const [friends, setFriends] = useState<Profile[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [inviteIds, setInviteIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const [{ data: fr }, { data: gs }] = await Promise.all([
          supabase
            .from('friendships')
            .select('*')
            .eq('status', 'accepted')
            .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`),
          supabase.from('friend_groups').select('id, name').eq('created_by', userId).order('name'),
        ]);
        setGroups((gs as { id: string; name: string }[]) ?? []);
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
        setGroups([]);
      }
    })();
  }, [open, userId]);

  async function applyGroupMembers(gid: string) {
    const { data } = await supabase
      .from('friend_group_members')
      .select('user_id')
      .eq('group_id', gid);
    const ids = Array.from(
      new Set((data ?? []).map((m: { user_id: string }) => m.user_id).filter((id) => id !== userId))
    );
    setInviteIds((prev) => Array.from(new Set([...prev, ...ids])));
    setGroupId(gid);
  }

  async function resolveInviteIds(): Promise<string[]> {
    if (mode === 'friends') {
      return friends.map((f) => f.id).filter((id) => id !== userId);
    }
    if (mode === 'group') {
      if (!groupId) return [];
      const { data } = await supabase
        .from('friend_group_members')
        .select('user_id')
        .eq('group_id', groupId);
      return Array.from(
        new Set((data ?? []).map((m: { user_id: string }) => m.user_id).filter((id) => id !== userId))
      );
    }
    return inviteIds.filter((id) => id !== userId);
  }

  async function submit() {
    setBusy(true);
    try {
      const ids = await resolveInviteIds();
      if (mode === 'invite' && !ids.length) {
        Alert.alert(t.common.error, t.form.needInviteFriends);
        return;
      }
      if (mode === 'group' && !groupId) {
        Alert.alert(t.common.error, t.form.needGroup);
        return;
      }
      if (mode === 'friends_of_friends' && !ids.length && !groupId) {
        Alert.alert(t.common.error, t.form.fofNeedInviteOrGroup);
        return;
      }
      if (mode === 'friends' && !ids.length) {
        Alert.alert(t.common.error, t.form.noFriends);
        return;
      }

      const patch: Partial<{
        privacy: Privacy;
        group_id: string | null;
        updated_at: string;
      }> = { updated_at: new Date().toISOString() };

      if (mode === 'friends') {
        patch.privacy = 'friends';
        patch.group_id = null;
      } else if (mode === 'friends_of_friends') {
        patch.privacy = 'friends_of_friends';
        patch.group_id = null;
      } else if (mode === 'group') {
        patch.privacy = 'group';
        patch.group_id = groupId;
      }

      if (patch.privacy || patch.group_id !== undefined) {
        const { error } = await supabase.from('activities').update(patch).eq('id', activity.id);
        if (error) throw error;
      }

      const unique = Array.from(new Set(ids));
      if (unique.length) {
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
      }

      Alert.alert(t.common.ok, t.events.extraInviteDone);
      setOpen(false);
      setInviteIds([]);
      setGroupId(null);
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
        <Subtitle>{t.events.extraInvite}</Subtitle>
        <Text style={styles.link} onPress={() => setOpen((v) => !v)}>
          {open ? t.common.cancel : t.events.extraInviteOpen}
        </Text>
      </View>
      <Muted>{t.events.extraInviteHint}</Muted>

      {open ? (
        <View style={{ gap: 10 }}>
          <View style={styles.rowWrap}>
            {(
              [
                { key: 'invite' as const, label: t.events.inviteOnly },
                { key: 'group' as const, label: t.events.group },
                { key: 'friends' as const, label: t.events.friendsOnly },
                { key: 'friends_of_friends' as const, label: t.events.friendsOfFriends },
              ] as const
            ).map((p) => (
              <Chip
                key={p.key}
                label={p.label}
                active={mode === p.key}
                onPress={() => {
                  setMode(p.key);
                  setInviteIds([]);
                  setGroupId(null);
                }}
              />
            ))}
          </View>

          {mode === 'invite' || mode === 'friends_of_friends' ? (
            <View>
              {mode === 'friends_of_friends' ? <Muted>{t.form.fofHint}</Muted> : null}
              <FriendPicker
                friends={friends}
                selectedIds={inviteIds}
                onChange={setInviteIds}
                label={t.form.selectFriends}
                placeholder={t.form.searchFriends}
                emptyHint={t.form.noFriends}
              />
              {mode === 'friends_of_friends' ? (
                <>
                  <Text style={styles.section}>{t.form.orSelectGroup}</Text>
                  {groups.length === 0 ? (
                    <Muted>{t.form.noGroups}</Muted>
                  ) : (
                    <View style={styles.rowWrap}>
                      {groups.map((g) => (
                        <Chip
                          key={g.id}
                          label={g.name}
                          active={false}
                          onPress={() => void applyGroupMembers(g.id)}
                        />
                      ))}
                    </View>
                  )}
                </>
              ) : null}
            </View>
          ) : null}

          {mode === 'friends' ? <Muted>{t.form.allFriendsInvited(friends.length)}</Muted> : null}

          {mode === 'group' ? (
            <View>
              {groups.length === 0 ? (
                <Muted>{t.form.noGroups}</Muted>
              ) : (
                <View style={styles.rowWrap}>
                  {groups.map((g) => (
                    <Chip
                      key={g.id}
                      label={g.name}
                      active={groupId === g.id}
                      onPress={() => setGroupId(g.id)}
                    />
                  ))}
                </View>
              )}
            </View>
          ) : null}

          <Button label={t.events.extraInviteApply} loading={busy} onPress={() => void submit()} />
        </View>
      ) : null}
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
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  section: {
    marginTop: 8,
    marginBottom: 4,
    fontSize: 14,
    fontWeight: '600',
    color: theme.colors.text,
  },
});
