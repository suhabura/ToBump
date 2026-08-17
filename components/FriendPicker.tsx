import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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
  selectAllLabel?: string;
  clearLabel?: string;
  selectedLabel?: (n: number) => string;
};

export function FriendPicker({
  friends,
  selectedIds,
  onChange,
  label = 'Friend',
  placeholder = 'Search by name…',
  emptyHint = 'Add friends first.',
  selectAllLabel = 'Select all',
  clearLabel = 'Clear',
  selectedLabel = (n) => `Selected (${n})`,
}: Props) {
  const [query, setQuery] = useState('');

  const sorted = useMemo(
    () =>
      [...friends].sort((a, b) =>
        displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' })
      ),
    [friends]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((f) => {
      const name = displayName(f).toLowerCase();
      const email = (f.email ?? '').toLowerCase();
      return name.includes(q) || email.includes(q);
    });
  }, [sorted, query]);

  const selected = useMemo(
    () => sorted.filter((f) => selectedIds.includes(f.id)),
    [sorted, selectedIds]
  );

  function toggle(id: string) {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  }

  function selectAllVisible() {
    const ids = new Set(selectedIds);
    for (const f of filtered) ids.add(f.id);
    onChange(Array.from(ids));
  }

  function clearAll() {
    onChange([]);
  }

  if (friends.length === 0) {
    return <Muted>{emptyHint}</Muted>;
  }

  return (
    <View style={styles.wrap}>
      <Input label={label} value={query} onChangeText={setQuery} placeholder={placeholder} />

      <View style={styles.actions}>
        <Chip label={selectAllLabel} onPress={selectAllVisible} />
        {selectedIds.length > 0 ? <Chip label={clearLabel} onPress={clearAll} /> : null}
      </View>

      <ScrollView style={styles.list} nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {filtered.length === 0 ? (
          <Muted>No matches.</Muted>
        ) : (
          filtered.map((f) => {
            const active = selectedIds.includes(f.id);
            return (
              <Pressable
                key={f.id}
                style={[styles.item, active && styles.itemActive]}
                onPress={() => toggle(f.id)}>
                <View style={[styles.check, active && styles.checkActive]}>
                  {active ? <Text style={styles.checkMark}>✓</Text> : null}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemText}>{displayName(f)}</Text>
                  {f.email ? <Text style={styles.email}>{f.email}</Text> : null}
                </View>
              </Pressable>
            );
          })
        )}
      </ScrollView>

      {selected.length > 0 ? (
        <View style={styles.selected}>
          <Muted>{selectedLabel(selected.length)}</Muted>
          <View style={styles.rowWrap}>
            {selected.map((f) => (
              <Chip
                key={f.id}
                label={`${displayName(f)} ×`}
                active
                onPress={() => toggle(f.id)}
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
  wrap: { marginBottom: theme.space.md },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: theme.space.sm },
  list: {
    maxHeight: 260,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.sm,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  itemActive: {
    backgroundColor: theme.colors.primarySoft,
  },
  check: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
  },
  checkActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primary,
  },
  checkMark: { color: '#fff', fontSize: 13, fontWeight: '800', lineHeight: 16 },
  itemText: { fontSize: 15, color: theme.colors.text, fontWeight: '600' },
  email: { fontSize: 12, color: theme.colors.textMuted, marginTop: 1 },
  selected: { marginTop: 8 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6 },
});
