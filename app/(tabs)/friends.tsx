import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
import { Button, EmptyState, Input, Loading, Muted, Screen, Subtitle } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { createNotification } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import type { Friendship, Profile } from '@/lib/types';
import { displayName } from '@/lib/types';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

type FriendRow = Friendship & {
  other: Profile | null;
};

export default function FriendsScreen() {
  const t = useT();
  const { user } = useAuth();
  const router = useRouter();
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [requests, setRequests] = useState<(Friendship & { from: Profile | null })[]>([]);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    const { data: fr } = await supabase
      .from('friendships')
      .select('*')
      .eq('status', 'accepted')
      .or(`from_user_id.eq.${user.id},to_user_id.eq.${user.id}`);

    const friendRows = (fr ?? []) as Friendship[];
    const otherIds = friendRows.map((f) => (f.from_user_id === user.id ? f.to_user_id : f.from_user_id));
    const { data: profiles } = otherIds.length
      ? await supabase.from('profiles').select('*').in('id', otherIds)
      : { data: [] as Profile[] };
    const map = new Map((profiles as Profile[]).map((p) => [p.id, p]));
    setFriends(
      friendRows.map((f) => ({
        ...f,
        other: map.get(f.from_user_id === user.id ? f.to_user_id : f.from_user_id) ?? null,
      }))
    );

    const { data: req } = await supabase
      .from('friendships')
      .select('*')
      .eq('to_user_id', user.id)
      .eq('status', 'pending');
    const reqRows = (req ?? []) as Friendship[];
    const fromIds = reqRows.map((r) => r.from_user_id);
    const { data: fromProfiles } = fromIds.length
      ? await supabase.from('profiles').select('*').in('id', fromIds)
      : { data: [] as Profile[] };
    const fromMap = new Map((fromProfiles as Profile[]).map((p) => [p.id, p]));
    setRequests(reqRows.map((r) => ({ ...r, from: fromMap.get(r.from_user_id) ?? null })));

    setLoading(false);
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  async function onSearch() {
    if (!user || !search.trim()) return;
    const q = search.trim();
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .neq('id', user.id)
      .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%`)
      .limit(20);
    setResults((data as Profile[]) ?? []);
  }

  async function sendRequest(toUserId: string) {
    if (!user) return;
    const { error } = await supabase.from('friendships').insert({
      from_user_id: user.id,
      to_user_id: toUserId,
      status: 'pending',
    });
    if (error) {
      Alert.alert(t.common.error, error.message);
      return;
    }
    await createNotification(toUserId, 'friend_request', t.friends.newRequest, {
      from_user_id: user.id,
    });
    Alert.alert('OK', t.friends.requestSent);
    load();
  }

  async function respond(id: string, status: 'accepted' | 'rejected', fromUserId: string) {
    if (!user) return;
    await supabase.from('friendships').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
    if (status === 'accepted') {
      await createNotification(fromUserId, 'friend_accepted', t.friends.requestAccepted, {
        user_id: user.id,
      });
    }
    load();
  }

  if (loading) return <Loading />;

  return (
    <Screen>
      <Input
        placeholder={t.friends.search}
        value={search}
        onChangeText={setSearch}
        onSubmitEditing={onSearch}
        returnKeyType="search"
      />
      <Button label={t.friends.searchAction} variant="secondary" onPress={onSearch} />

      {results.length ? (
        <View style={{ marginTop: 12 }}>
          <Subtitle>{t.friends.results}</Subtitle>
          {results.map((p) => (
            <View key={p.id} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{displayName(p)}</Text>
                <Muted>{p.email}</Muted>
              </View>
              <Button label={t.friends.add} onPress={() => sendRequest(p.id)} />
            </View>
          ))}
        </View>
      ) : null}

      <View style={{ marginTop: 16 }}>
        <Subtitle>{t.friends.requests}</Subtitle>
        {requests.length === 0 ? <Muted>{t.friends.noRequests}</Muted> : null}
        {requests.map((r) => (
          <View key={r.id} style={styles.row}>
            <Text style={[styles.name, { flex: 1 }]}>{displayName(r.from)}</Text>
            <Button label={t.friends.accept} onPress={() => respond(r.id, 'accepted', r.from_user_id)} />
            <Button label={t.friends.reject} variant="ghost" onPress={() => respond(r.id, 'rejected', r.from_user_id)} />
          </View>
        ))}
      </View>

      <View style={{ marginTop: 16, marginBottom: 8 }}>
        <Button label={t.friends.manageGroups} variant="secondary" onPress={() => router.push('/groups')} />
      </View>
      <View style={{ flex: 1 }}>
        <Subtitle>{t.friends.title}</Subtitle>
        <FlatList
          data={friends}
          keyExtractor={(i) => i.id}
          ListEmptyComponent={<EmptyState title={t.friends.empty} />}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View>
                <Text style={styles.name}>{displayName(item.other)}</Text>
                <Muted>{item.other?.email}</Muted>
              </View>
            </View>
          )}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: 8,
  },
  name: { fontWeight: '700', color: theme.colors.text, fontSize: 16 },
});
