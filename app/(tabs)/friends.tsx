import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Button, EmptyState, Input, Loading, Muted, Screen, Subtitle } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { createNotification } from '@/lib/api';
import { showAlert } from '@/lib/dialog';
import { dedupeFriendshipsByOther, dedupeProfilesByEmail, friendshipOtherId } from '@/lib/friends';
import { supabase } from '@/lib/supabase';
import type { Friendship, Profile } from '@/lib/types';
import { displayName } from '@/lib/types';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

type FriendRow = Friendship & {
  other: Profile | null;
};

const MIN_SEARCH = 2;
const SEARCH_DEBOUNCE_MS = 250;

function sanitizeSearch(q: string): string {
  return q.replace(/[%_,()]/g, ' ').replace(/\s+/g, ' ').trim();
}

export default function FriendsScreen() {
  const t = useT();
  const { user } = useAuth();
  const router = useRouter();
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [requests, setRequests] = useState<(Friendship & { from: Profile | null })[]>([]);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Profile[]>([]);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const searchSeq = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    const { data: fr } = await supabase
      .from('friendships')
      .select('*')
      .eq('status', 'accepted')
      .or(`from_user_id.eq.${user.id},to_user_id.eq.${user.id}`);

    const friendRows = dedupeFriendshipsByOther((fr ?? []) as Friendship[], user.id);
    const otherIds = friendRows.map((f) => friendshipOtherId(f, user.id));
    const { data: profiles } = otherIds.length
      ? await supabase.from('profiles').select('*').in('id', otherIds)
      : { data: [] as Profile[] };
    const uniqueProfiles = dedupeProfilesByEmail((profiles as Profile[]) ?? []);
    const map = new Map(uniqueProfiles.map((p) => [p.id, p]));
    // Also index by email so duplicate profile ids collapse visually
    const byEmail = new Map(
      uniqueProfiles.filter((p) => p.email).map((p) => [p.email!.trim().toLowerCase(), p])
    );
    const seenEmails = new Set<string>();
    setFriends(
      friendRows
        .map((f) => {
          const otherId = friendshipOtherId(f, user.id);
          const other = map.get(otherId) ?? null;
          return { ...f, other };
        })
        .filter((row) => {
          const email = row.other?.email?.trim().toLowerCase();
          if (!email) return true;
          if (seenEmails.has(email)) return false;
          seenEmails.add(email);
          // Prefer canonical profile for that email
          if (byEmail.has(email)) row.other = byEmail.get(email)!;
          return true;
        })
    );

    const { data: req } = await supabase
      .from('friendships')
      .select('*')
      .eq('to_user_id', user.id)
      .eq('status', 'pending');
    const reqRows = dedupeFriendshipsByOther((req ?? []) as Friendship[], user.id);
    const fromIds = reqRows.map((r) => r.from_user_id);
    const { data: fromProfiles } = fromIds.length
      ? await supabase.from('profiles').select('*').in('id', fromIds)
      : { data: [] as Profile[] };
    const fromMap = new Map(
      dedupeProfilesByEmail((fromProfiles as Profile[]) ?? []).map((p) => [p.id, p])
    );
    setRequests(reqRows.map((r) => ({ ...r, from: fromMap.get(r.from_user_id) ?? null })));

    setLoading(false);
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const exclude = useMemo(() => {
    const ids = new Set<string>();
    const emails = new Set<string>();
    for (const f of friends) {
      ids.add(friendshipOtherId(f, user?.id ?? ''));
      if (f.other?.id) ids.add(f.other.id);
      const email = f.other?.email?.trim().toLowerCase();
      if (email) emails.add(email);
    }
    for (const r of requests) ids.add(r.from_user_id);
    return { ids, emails };
  }, [friends, requests, user?.id]);

  const runSearch = useCallback(
    async (raw: string) => {
      if (!user) return;
      const q = sanitizeSearch(raw);
      if (q.length < MIN_SEARCH) {
        searchSeq.current += 1;
        setResults([]);
        setSearching(false);
        return;
      }
      const seq = ++searchSeq.current;
      setSearching(true);
      const { data } = await supabase
        .from('profiles')
        .select('*')
        .neq('id', user.id)
        .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%`)
        .limit(40);
      if (seq !== searchSeq.current) return;
      setResults(
        dedupeProfilesByEmail((data as Profile[]) ?? [])
          .filter((p) => !exclude.ids.has(p.id))
          .filter((p) => {
            const email = p.email?.trim().toLowerCase();
            return !email || !exclude.emails.has(email);
          })
          .slice(0, 20)
      );
      setSearching(false);
    },
    [user, exclude]
  );

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = sanitizeSearch(search);
    if (q.length < MIN_SEARCH) {
      searchSeq.current += 1;
      setResults([]);
      setSearching(false);
      return;
    }
    searchTimer.current = setTimeout(() => {
      void runSearch(search);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [search, runSearch]);

  async function sendRequest(toUserId: string) {
    if (!user) return;

    const { data: rpcId, error: rpcError } = await supabase.rpc('send_friend_request', {
      p_to_user_id: toUserId,
    });

    if (!rpcError) {
      if (rpcId) {
        await createNotification(toUserId, 'friend_request', t.friends.newRequest, {
          from_user_id: user.id,
        });
      }
      showAlert('OK', t.friends.requestSent);
      setResults([]);
      setSearch('');
      load();
      return;
    }

    // Fallback until friendships_unique.sql is applied
    const { data: existing } = await supabase
      .from('friendships')
      .select('*')
      .or(
        `and(from_user_id.eq.${user.id},to_user_id.eq.${toUserId}),and(from_user_id.eq.${toUserId},to_user_id.eq.${user.id})`
      )
      .limit(1)
      .maybeSingle();

    if (existing) {
      if (existing.status === 'accepted') {
        showAlert(t.common.error, t.friends.alreadyFriends);
        return;
      }
      if (existing.status === 'pending') {
        if (existing.to_user_id === user.id) {
          await respond(existing.id, 'accepted', existing.from_user_id);
          return;
        }
        showAlert(t.common.error, t.friends.alreadyPending);
        return;
      }
    }

    const { error } = await supabase.from('friendships').insert({
      from_user_id: user.id,
      to_user_id: toUserId,
      status: 'pending',
    });
    if (error) {
      const msg = /duplicate|unique/i.test(error.message)
        ? t.friends.alreadyPending
        : error.message;
      showAlert(t.common.error, msg);
      return;
    }
    await createNotification(toUserId, 'friend_request', t.friends.newRequest, {
      from_user_id: user.id,
    });
    showAlert('OK', t.friends.requestSent);
    setResults([]);
    setSearch('');
    load();
  }

  async function respond(id: string, status: 'accepted' | 'rejected', fromUserId: string) {
    if (!user) return;

    if (status === 'accepted') {
      const { error: rpcError } = await supabase.rpc('accept_friend_request', {
        p_friendship_id: id,
      });
      if (rpcError) {
        await supabase
          .from('friendships')
          .update({ status: 'accepted', updated_at: new Date().toISOString() })
          .eq('id', id);
        // Best-effort: remove reverse duplicate
        await supabase
          .from('friendships')
          .delete()
          .neq('id', id)
          .or(
            `and(from_user_id.eq.${user.id},to_user_id.eq.${fromUserId}),and(from_user_id.eq.${fromUserId},to_user_id.eq.${user.id})`
          );
      }
      await createNotification(fromUserId, 'friend_accepted', t.friends.requestAccepted, {
        user_id: user.id,
      });
    } else {
      await supabase
        .from('friendships')
        .update({ status: 'rejected', updated_at: new Date().toISOString() })
        .eq('id', id);
    }
    load();
  }

  async function removeFriend(row: FriendRow) {
    if (!user || !row.id) return;
    const pairIds = Array.from(
      new Set([friendshipOtherId(row, user.id), row.other?.id].filter((id): id is string => Boolean(id)))
    );

    setRemovingId(row.id);
    const { error } = await supabase.from('friendships').delete().eq('id', row.id);
    if (error) {
      setRemovingId(null);
      setPendingRemoveId(null);
      showAlert(t.common.error, t.friends.removeFailed);
      return;
    }
    for (const oid of pairIds) {
      await supabase.from('friendships').delete().eq('from_user_id', user.id).eq('to_user_id', oid);
      await supabase.from('friendships').delete().eq('from_user_id', oid).eq('to_user_id', user.id);
    }
    setFriends((prev) =>
      prev.filter((f) => f.id !== row.id && !pairIds.includes(friendshipOtherId(f, user.id)))
    );
    setPendingRemoveId(null);
    setRemovingId(null);
    await load();
  }

  if (loading) return <Loading />;

  return (
    <Screen>
      <Input
        placeholder={t.friends.search}
        value={search}
        onChangeText={setSearch}
        onSubmitEditing={() => void runSearch(search)}
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
      />

      {sanitizeSearch(search).length >= MIN_SEARCH ? (
        <View style={{ marginTop: 12 }}>
          <Subtitle>{t.friends.results}</Subtitle>
          {searching && !results.length ? <Muted>{t.common.loading}</Muted> : null}
          {!searching && !results.length ? <Muted>{t.friends.noMatches}</Muted> : null}
          {results.map((p) => (
            <View key={p.id} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{displayName(p)}</Text>
                <Muted>{p.email}</Muted>
              </View>
              <Button label={t.friends.add} size="xs" onPress={() => sendRequest(p.id)} />
            </View>
          ))}
        </View>
      ) : null}

      {requests.length > 0 ? (
        <View style={{ marginTop: 16 }}>
          <Subtitle>{t.friends.requests}</Subtitle>
          {requests.map((r) => (
            <View key={r.id} style={styles.row}>
              <Text style={[styles.name, { flex: 1 }]}>{displayName(r.from)}</Text>
              <Button label={t.friends.accept} size="xs" onPress={() => respond(r.id, 'accepted', r.from_user_id)} />
              <Button label={t.friends.reject} variant="ghost" size="xs" onPress={() => respond(r.id, 'rejected', r.from_user_id)} />
            </View>
          ))}
        </View>
      ) : null}

      <View style={{ flex: 1, marginTop: 16 }}>
        <Subtitle>{t.friends.title}</Subtitle>
        <FlatList
          data={friends}
          keyExtractor={(i) => i.other?.email?.trim().toLowerCase() || i.id}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<EmptyState title={t.friends.empty} />}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Text style={[styles.name, { flex: 1 }]}>{displayName(item.other)}</Text>
              {pendingRemoveId === item.id ? (
                <>
                  <Button
                    label={t.common.cancel}
                    variant="ghost"
                    size="xs"
                    onPress={() => setPendingRemoveId(null)}
                  />
                  <Button
                    label={t.friends.remove}
                    variant="dangerOutline"
                    size="xs"
                    icon="user-times"
                    loading={removingId === item.id}
                    onPress={() => void removeFriend(item)}
                  />
                </>
              ) : (
                <Pressable
                  onPress={() => setPendingRemoveId(item.id)}
                  accessibilityRole="button"
                  accessibilityLabel={t.friends.remove}
                  hitSlop={8}>
                  <FontAwesome name="user-times" size={16} color={theme.colors.textMuted} />
                </Pressable>
              )}
            </View>
          )}
        />
        <Text style={styles.link} onPress={() => router.push('/groups')}>
          {t.friends.manageGroups}
        </Text>
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
    ...theme.shadow.card,
  },
  name: { fontWeight: '700', color: theme.colors.text, fontSize: 16 },
  link: {
    color: theme.colors.primary,
    fontWeight: '600',
    fontSize: 15,
    marginTop: 8,
  },
});
