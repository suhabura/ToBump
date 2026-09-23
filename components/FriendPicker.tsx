import { useEffect, useMemo, useRef, useState } from 'react';
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
  /** Always shown when selected; cannot be removed */
  lockedIds?: string[];
  /** Profiles for selected people who may not be in `friends` (self, editors, …) */
  extraProfiles?: Profile[];
};

export function FriendPicker({
  friends,
  selectedIds,
  onChange,
  label = 'Friend',
  placeholder = 'Search by name…',
  emptyHint = 'Add friends first.',
  lockedIds = [],
  extraProfiles = [],
}: Props) {
  const [query, setQuery] = useState('');
  const picking = useRef(false);
  const pickedAt = useRef(0);
  const locked = useMemo(() => new Set(lockedIds), [lockedIds]);

  const people = useMemo(() => {
    const byId = new Map<string, Profile>();
    for (const f of friends) byId.set(f.id, f);
    for (const p of extraProfiles) byId.set(p.id, p);
    return byId;
  }, [friends, extraProfiles]);

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
      selectedIds
        .map((id) => people.get(id))
        .filter((p): p is Profile => Boolean(p))
        .sort((a, b) =>
          displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' })
        ),
    [people, selectedIds]
  );

  function pick(friend: Profile, source: string) {
    picking.current = true;
    pickedAt.current = Date.now();
    const already = selectedIds.includes(friend.id);
    // #region agent log
    fetch('http://127.0.0.1:7934/ingest/22b91ff0-7fd0-4a8e-9fd9-fb2a5a18cb92',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d24ac1'},body:JSON.stringify({sessionId:'d24ac1',runId:'pre-fix',hypothesisId:'A',location:'FriendPicker.tsx:pick',message:'pick called',data:{source,before:selectedIds.length,already,idTail:friend.id.slice(-6)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (!already) {
      onChange([...selectedIds, friend.id]);
    }
    setQuery('');
  }

  useEffect(() => {
    const missing = selectedIds.filter((id) => !people.has(id)).length;
    // #region agent log
    fetch('http://127.0.0.1:7934/ingest/22b91ff0-7fd0-4a8e-9fd9-fb2a5a18cb92',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d24ac1'},body:JSON.stringify({sessionId:'d24ac1',runId:'pre-fix',hypothesisId:'C',location:'FriendPicker.tsx:selection',message:'selection render',data:{requested:selectedIds.length,resolved:selected.length,missing,queryLen:query.trim().length,matchCount:matches.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  }, [selectedIds, selected.length, people, query, matches.length]);

  function remove(id: string) {
    // #region agent log
    fetch('http://127.0.0.1:7934/ingest/22b91ff0-7fd0-4a8e-9fd9-fb2a5a18cb92',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d24ac1'},body:JSON.stringify({sessionId:'d24ac1',runId:'pre-fix',hypothesisId:'D',location:'FriendPicker.tsx:remove',message:'remove called',data:{idTail:id.slice(-6),before:selectedIds.length,picking:picking.current,locked:locked.has(id)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (locked.has(id)) return;
    if (Date.now() - pickedAt.current < 500) return;
    onChange(selectedIds.filter((x) => x !== id));
  }

  if (friends.length === 0 && extraProfiles.length === 0) {
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
                onPressIn={() => {
                  // #region agent log
                  fetch('http://127.0.0.1:7934/ingest/22b91ff0-7fd0-4a8e-9fd9-fb2a5a18cb92',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d24ac1'},body:JSON.stringify({sessionId:'d24ac1',runId:'pre-fix',hypothesisId:'A',location:'FriendPicker.tsx:onPressIn',message:'press in',data:{idTail:f.id.slice(-6)},timestamp:Date.now()})}).catch(()=>{});
                  // #endregion
                  pick(f, 'pressIn');
                }}
                {...(Platform.OS === 'web'
                  ? {
                      onMouseDown: (e: { preventDefault?: () => void }) => {
                        // #region agent log
                        fetch('http://127.0.0.1:7934/ingest/22b91ff0-7fd0-4a8e-9fd9-fb2a5a18cb92',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d24ac1'},body:JSON.stringify({sessionId:'d24ac1',runId:'pre-fix',hypothesisId:'A',location:'FriendPicker.tsx:onMouseDown',message:'mouse down',data:{idTail:f.id.slice(-6)},timestamp:Date.now()})}).catch(()=>{});
                        // #endregion
                        e.preventDefault?.();
                        pick(f, 'mouseDown');
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
                label={locked.has(f.id) ? displayName(f) : `${displayName(f)} ×`}
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
