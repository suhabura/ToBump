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
  const [activityTitle, setActivityTitle] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const listRef = useRef<FlatList>(null);
  const threadIdRef = useRef(activityId);

  useEffect(() => {
    if (!activityId) return;
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    (async () => {
      const first = await supabase
        .from('activities')
        .select('title, created_by, series_id, recurrence_dates')
        .eq('id', activityId)
        .single();
      let act = first.data as {
        title?: string;
        created_by?: string;
        series_id?: string | null;
        recurrence_dates?: string[];
      } | null;
      if (first.error && /recurrence_dates/i.test(first.error.message ?? '')) {
        const retry = await supabase
          .from('activities')
          .select('title, created_by, series_id')
          .eq('id', activityId)
          .single();
        act = retry.data;
      } else if (first.error) {
        act = null;
      }
      if (cancelled) return;
      setActivityTitle(act?.title ?? '');
      const dates = Array.isArray(act?.recurrence_dates) ? act.recurrence_dates : [];
      const isDateSeries = dates.length >= 2;
      const sid = (act?.series_id as string | undefined) || activityId;
      let activityIds = [activityId];
      if (isDateSeries) {
        const { data: sibs } = await supabase
          .from('activities')
          .select('id')
          .or(`id.eq.${sid},series_id.eq.${sid}`);
        activityIds = Array.from(new Set((sibs ?? []).map((s: { id: string }) => s.id)));
        if (!activityIds.length) activityIds = [activityId];
      }
      const threadId = isDateSeries ? sid : activityId;
      threadIdRef.current = threadId;

      const { data: joins } = await supabase
        .from('activity_joins')
        .select('user_id')
        .in('activity_id', activityIds);
      const ids = new Set((joins ?? []).map((j: { user_id: string }) => j.user_id));
      if (act?.created_by) ids.add(act.created_by);
      setMemberIds([...ids]);

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
          { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `activity_id=eq.${threadId}` },
          async (payload) => {
            const row = payload.new as ChatMessage;
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
  }, [activityId]);

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
    for (const uid of memberIds) {
      if (uid === user.id) continue;
      await createNotification(uid, 'message', t.chat.newMessage(activityTitle), {
        activity_id: threadIdRef.current,
      });
    }
  }

  if (loading) return <Loading />;

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
