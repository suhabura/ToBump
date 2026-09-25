import { format } from 'date-fns';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Button, Loading, Muted } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { createNotification } from '@/lib/api';
import { isChatOpen } from '@/lib/recurrence';
import { supabase } from '@/lib/supabase';
import type { ChatMessage, Profile } from '@/lib/types';
import { displayName } from '@/lib/types';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

type Msg = ChatMessage & { profiles?: Pick<Profile, 'first_name' | 'last_name'> | null };

export default function ChatScreen() {
  const t = useT();
  const { activityId } = useLocalSearchParams<{ activityId: string }>();
  const { user } = useAuth();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [closed, setClosed] = useState(false);
  const [activityTitle, setActivityTitle] = useState('');
  const fallbackRecipients = useRef<string[]>([]);
  const listRef = useRef<FlatList>(null);
  const threadIdRef = useRef(activityId);

  useEffect(() => {
    if (!activityId || !user) return;
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    (async () => {
      const first = await supabase
        .from('activities')
        .select('title, series_id')
        .eq('id', activityId)
        .single();
      const act = first.error
        ? null
        : (first.data as { title?: string; series_id?: string | null } | null);
      if (cancelled) return;
      setActivityTitle(act?.title ?? '');
      const sid = act?.series_id || activityId;
      const { data: sibs } = await supabase
        .from('activities')
        .select('id, starts_at, ends_at, status')
        .or(`id.eq.${sid},series_id.eq.${sid}`);
      const rows = (sibs ?? []) as { id: string; starts_at: string; ends_at: string | null; status: string | null }[];
      const activityIds = Array.from(new Set(rows.map((s) => s.id).concat(activityId)));
      const openIds = rows.filter((row) => isChatOpen(row)).map((row) => row.id);
      const threadId = sid;
      threadIdRef.current = threadId;
      const siblingSet = new Set(activityIds);

      const [{ data: myJoins }, { data: follow }] = await Promise.all([
        openIds.length
          ? supabase.from('activity_joins').select('activity_id').eq('user_id', user.id).in('activity_id', openIds)
          : Promise.resolve({ data: [] as { activity_id: string }[] }),
        supabase.from('series_follows').select('series_id').eq('user_id', user.id).eq('series_id', sid).maybeSingle(),
      ]);
      const allowed = (myJoins?.length ?? 0) > 0 || (Boolean(follow) && openIds.length > 0);
      if (!cancelled) setClosed(!allowed);
      if (!allowed) {
        if (!cancelled) {
          setClosed(true);
          setLoading(false);
        }
        return;
      }

      const { data: joins } = openIds.length
        ? await supabase.from('activity_joins').select('user_id').in('activity_id', openIds)
        : { data: [] as { user_id: string }[] };
      fallbackRecipients.current = Array.from(new Set((joins ?? []).map((j: { user_id: string }) => j.user_id)));

      const { data } = await supabase
        .from('chat_messages')
        .select('*, profiles:user_id(first_name, last_name)')
        .in('activity_id', activityIds)
        .order('created_at', { ascending: true });
      if (cancelled) return;
      setMessages((data as Msg[]) ?? []);
      setLoading(false);

      channel = supabase
        .channel(`chat-${threadId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'chat_messages' },
          async (payload) => {
            const row = payload.new as ChatMessage;
            if (!siblingSet.has(row.activity_id)) return;
            const { data: profile } = await supabase
              .from('profiles')
              .select('first_name, last_name')
              .eq('id', row.user_id)
              .maybeSingle();
            setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, { ...row, profiles: profile }]));
          }
        )
        .subscribe();
      if (cancelled) {
        supabase.removeChannel(channel);
      }
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [activityId, user]);

  async function send() {
    if (!user || !text.trim() || !threadIdRef.current) return;
    const message = text.trim();
    setText('');
    const { error } = await supabase.from('chat_messages').insert({
      activity_id: threadIdRef.current,
      user_id: user.id,
      message,
    });
    if (error) {
      setText(message);
      return;
    }
    const { data: recipients, error: recErr } = await supabase.rpc('chat_thread_recipients', {
      p_activity_id: threadIdRef.current,
    });
    const missing = recErr && /function|does not exist|schema cache/i.test(recErr.message ?? '');
    const ids = missing
      ? fallbackRecipients.current
      : ((recipients as string[] | null) ?? []);
    for (const uid of ids) {
      if (uid === user.id) continue;
      await createNotification(uid, 'message', t.chat.newMessage(activityTitle), {
        activity_id: threadIdRef.current,
      });
    }
  }

  if (loading) return <Loading />;
  if (closed) {
    return (
      <View style={styles.closed}>
        <Muted>{t.chat.closed}</Muted>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.wrap}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 16, paddingBottom: 8 }}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={<Muted>{t.chat.empty}</Muted>}
        renderItem={({ item }) => {
          const mine = item.user_id === user?.id;
          return (
            <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
              {!mine ? <Text style={styles.author}>{displayName(item.profiles)}</Text> : null}
              <Text style={[styles.msg, mine && { color: '#fff' }]}>{item.message}</Text>
              <Text style={[styles.time, mine && { color: theme.colors.primaryMuted }]}>
                {format(new Date(item.created_at), 'HH:mm')}
              </Text>
            </View>
          );
        }}
      />
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder={t.chat.placeholder}
          placeholderTextColor={theme.colors.textMuted}
        />
        <Button label={t.chat.send} onPress={send} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.colors.background },
  closed: { flex: 1, backgroundColor: theme.colors.background, padding: 24, justifyContent: 'center' },
  bubble: {
    maxWidth: '80%',
    padding: 12,
    borderRadius: 14,
    marginBottom: 8,
  },
  mine: {
    alignSelf: 'flex-end',
    backgroundColor: theme.colors.primary,
  },
  theirs: {
    alignSelf: 'flex-start',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  author: { fontSize: 12, fontWeight: '700', color: theme.colors.primary, marginBottom: 4 },
  msg: { color: theme.colors.text, fontSize: 15 },
  time: { fontSize: 11, color: theme.colors.textMuted, marginTop: 4, alignSelf: 'flex-end' },
  composer: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: theme.colors.text,
  },
});
