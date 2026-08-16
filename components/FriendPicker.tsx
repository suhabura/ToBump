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
  const [focused, setFocused] = useState(false);
  const picking = useRef(false);

  const selected = useMemo(
    () => friends.filter((f) => selectedIds.includes(f.id)),
    [friends, selectedIds]
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const available = friends.filter((f) => !selectedIds.includes(f.id));
    if (!q) return available.slice(0, 8);
    return available
      .filter((f) => displayName(f).toLowerCase().includes(q))
      .slice(0, 8);
  }, [friends, query, selectedIds]);

  const showList = focused && matches.length > 0;

  function pick(friend: Profile) {
    picking.current = true;
    if (!selectedIds.includes(friend.id)) {
      onChange([...selectedIds, friend.id]);
    }
    setQuery('');
    setFocused(false);
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
        onFocus={() => {
          picking.current = false;
          setFocused(true);
        }}
        onBlur={() => {
          setTimeout(() => {
            if (!picking.current) setFocused(false);
            picking.current = false;
          }, Platform.OS === 'web' ? 250 : 150);
        }}
      />
      {showList ? (
        <View style={styles.list}>
          {matches.map((f) => (
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
            </Pressable>
          ))}
        </View>
      ) : null}

      {selected.length > 0 ? (
        <View style={styles.selected}>
          <Muted>Selected ({selected.length})</Muted>
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
      ) : (
        <Muted>No friends selected yet.</Muted>
      )}
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
  itemText: { fontSize: 15, color: theme.colors.text },
  selected: { marginTop: 4 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6 },
});
