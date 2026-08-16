import { useCallback, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Button, EmptyState, Input, Loading, Muted, Screen, Subtitle } from '@/components/ui';
import { FriendPicker } from '@/components/FriendPicker';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import type { FriendGroup, Profile } from '@/lib/types';
import { displayName } from '@/lib/types';
import { useT, type Translations } from '@/i18n';
import { theme } from '@/constants/theme';

type GroupWithMembers = FriendGroup & { memberIds: string[] };

function errMessage(e: unknown, t: Translations): string {
  if (!e) return t.common.error;
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) {
    return String((e as { message: unknown }).message);
  }
  return JSON.stringify(e);
}

export default function GroupsScreen() {
  const t = useT();
  const { user } = useAuth();
  const [groups, setGroups] = useState<GroupWithMembers[]>([]);
  const [friends, setFriends] = useState<Profile[]>([]);
  const [name, setName] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data: grp, error: gErr } = await supabase
        .from('friend_groups')
        .select('*')
        .eq('created_by', user.id)
        .order('name');
      if (gErr) throw gErr;

      const groupsRaw = (grp as FriendGroup[]) ?? [];
      const withMembers: GroupWithMembers[] = [];
      for (const g of groupsRaw) {
        const { data: mem, error: mErr } = await supabase
          .from('friend_group_members')
          .select('user_id')
          .eq('group_id', g.id);
        if (mErr) throw mErr;
        withMembers.push({
          ...g,
          memberIds: (mem ?? []).map((m: { user_id: string }) => m.user_id),
        });
      }
      setGroups(withMembers);

      const { data: fr, error: fErr } = await supabase
        .from('friendships')
        .select('*')
        .eq('status', 'accepted')
        .or(`from_user_id.eq.${user.id},to_user_id.eq.${user.id}`);
      if (fErr) throw fErr;

      const otherIds = (fr ?? []).map((f: { from_user_id: string; to_user_id: string }) =>
        f.from_user_id === user.id ? f.to_user_id : f.from_user_id
      );
      if (otherIds.length) {
        const { data: profiles, error: pErr } = await supabase
          .from('profiles')
          .select('*')
          .in('id', otherIds);
        if (pErr) throw pErr;
        setFriends((profiles as Profile[]) ?? []);
      } else {
        setFriends([]);
      }
    } catch (e) {
      setError(errMessage(e, t));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  async function createGroup() {
    if (!user || !name.trim()) {
      Alert.alert(t.common.error, t.groups.needName);
      return;
    }
    if (selectedMembers.length === 0) {
      Alert.alert(t.common.error, t.groups.needMember);
      return;
    }
    setSaving(true);
    const { data, error: err } = await supabase
      .from('friend_groups')
      .insert({ name: name.trim(), created_by: user.id })
      .select('id')
      .single();
    if (err || !data) {
      setSaving(false);
      Alert.alert(t.common.error, errMessage(err, t) || t.groups.createFailed);
      return;
    }
    const { error: memErr } = await supabase.from('friend_group_members').insert(
      selectedMembers.map((uid) => ({ group_id: data.id, user_id: uid }))
    );
    setSaving(false);
    if (memErr) {
      Alert.alert(t.common.error, errMessage(memErr, t));
      return;
    }
    setName('');
    setSelectedMembers([]);
    load();
  }

  async function deleteGroup(id: string) {
    await supabase.from('friend_groups').delete().eq('id', id);
    load();
  }

  if (loading) return <Loading />;

  return (
    <Screen>
      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.error}>{error}</Text>
          <Button label={t.common.retry} variant="secondary" onPress={load} />
        </View>
      ) : null}
      <Subtitle>{t.groups.newGroup}</Subtitle>
      <Input label={t.groups.name} value={name} onChangeText={setName} placeholder={t.groups.namePlaceholder} />
      <Muted>{t.groups.members}</Muted>
      <FriendPicker
        friends={friends}
        selectedIds={selectedMembers}
        onChange={setSelectedMembers}
        label={t.groups.addMember}
      />
      <Button label={t.groups.create} onPress={createGroup} loading={saving} />

      <View style={{ height: 24 }} />
      <Subtitle>{t.groups.myGroups}</Subtitle>
      <FlatList
        data={groups}
        keyExtractor={(g) => g.id}
        ListEmptyComponent={<EmptyState title={t.groups.empty} />}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.name}>{item.name}</Text>
            <Muted>
              {t.groups.membersCount(item.memberIds.length)}{' '}
              {item.memberIds
                .map((id) => displayName(friends.find((f) => f.id === id) ?? null))
                .join(', ') || '—'}
            </Muted>
            <Button label={t.groups.delete} variant="ghost" onPress={() => deleteGroup(item.id)} />
          </View>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginVertical: 8 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: 8,
  },
  name: { fontWeight: '700', fontSize: 16, color: theme.colors.text, marginBottom: 4 },
  errorBox: { marginBottom: 12, gap: 8 },
  error: {
    color: theme.colors.danger,
    backgroundColor: '#FEE2E2',
    padding: 12,
    borderRadius: 8,
    fontWeight: '600',
  },
});
