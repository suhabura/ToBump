import { useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Chip, Input, Muted } from '@/components/ui';
import type { Profile } from '@/lib/types';
import { displayName } from '@/lib/types';
import { theme } from '@/constants/theme';

type Props = {
  friends: Profile[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  label?: string;
  placeholder?: string;
  emptyHint?: string;
};

export function FriendPicker({
  friends,
  selectedIds,
  onChange,
  label = 'Friend',
  placeholder = 'Search by name…',
  emptyHint = 'Add friends first.',
}: Props) {
  const [query, setQuery] = useState('');
  const picking = useRef(false);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return friends
      .filter((f) => !selectedIds.includes(f.id))
      .filter((f) => {
        const name = displayName(f).toLowerCase();
        const email = (f.email ?? '').toLowerCase();
        return name.includes(q) || email.includes(q);
      })
      .sort((a, b) =>
        displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' })
      )
      .slice(0, 12);
  }, [friends, query, selectedIds]);

  const selected = useMemo(
    () =>
      friends
        .filter((f) => selectedIds.includes(f.id))
        .sort((a, b) =>
          displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' })
        ),
    [friends, selectedIds]
  );

  function pick(friend: Profile) {
    picking.current = true;
    if (!selectedIds.includes(friend.id)) {
      onChange([...selectedIds, friend.id]);
    }
    setQuery('');
  }

  function remove(id: string) {
    onChange(selectedIds.filter((x) => x !== id));
  }

  if (friends.length === 0) {
    return <Muted>{emptyHint}</Muted>;
  }

  return (
    <View style={styles.wrap}>
      <Input
        label={label}
        value={query}
        onChangeText={setQuery}
        placeholder={placeholder}
        onBlur={() => {
          setTimeout(() => {
            picking.current = false;
          }, Platform.OS === 'web' ? 250 : 150);
        }}
      />
      {query.trim() ? (
        <View style={styles.list}>
          {matches.length === 0 ? (
            <Text style={styles.emptyMatch}>No matches</Text>
          ) : (
            matches.map((f) => (
              <Pressable
                key={f.id}
                style={styles.item}
                onPressIn={() => pick(f)}
                {...(Platform.OS === 'web'
                  ? {
                      onMouseDown: (e: { preventDefault?: () => void }) => {
                        e.preventDefault?.();
                        pick(f);
                      },
                    }
                  : {})}>
                <Text style={styles.itemText}>{displayName(f)}</Text>
                {f.email ? <Text style={styles.email}>{f.email}</Text> : null}
              </Pressable>
            ))
          )}
        </View>
      ) : null}

      {selected.length > 0 ? (
        <View style={styles.selected}>
          <View style={styles.rowWrap}>
            {selected.map((f) => (
              <Chip
                key={f.id}
                label={`${displayName(f)} ×`}
                active
                onPress={() => remove(f.id)}
              />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { zIndex: 10, marginBottom: theme.space.md },
  list: {
    marginTop: -8,
    marginBottom: theme.space.sm,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.sm,
    overflow: 'hidden',
  },
  item: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  emptyMatch: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: theme.colors.textMuted,
  },
  itemText: { fontSize: 15, color: theme.colors.text, fontWeight: '600' },
  email: { fontSize: 12, color: theme.colors.textMuted, marginTop: 2 },
  selected: { marginTop: 4 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
});
