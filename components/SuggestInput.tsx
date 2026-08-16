import { useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Input } from '@/components/ui';
import { theme } from '@/constants/theme';

type Props = {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  suggestions: string[];
  placeholder?: string;
  /** Map free text / aliases to a suggestion label (e.g. soccer → Football) */
  resolveAlias?: (text: string) => string | null;
};

export function SuggestInput({ label, value, onChangeText, suggestions, placeholder, resolveAlias }: Props) {
  const [focused, setFocused] = useState(false);
  const picking = useRef(false);

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return suggestions.slice(0, 8);
    const filtered = suggestions.filter((s) => s.toLowerCase().includes(q));
    const alias = resolveAlias?.(value);
    if (alias && suggestions.includes(alias) && !filtered.includes(alias)) {
      return [alias, ...filtered].slice(0, 8);
    }
    return filtered.slice(0, 8);
  }, [value, suggestions, resolveAlias]);

  const exactMatch =
    matches.length === 1 && matches[0].toLowerCase() === value.trim().toLowerCase();
  const showList = focused && matches.length > 0 && !exactMatch;

  const pick = (item: string) => {
    picking.current = true;
    onChangeText(item);
    setFocused(false);
  };

  return (
    <View style={styles.wrap}>
      <Input
        label={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        onFocus={() => {
          picking.current = false;
          setFocused(true);
        }}
        onBlur={() => {
          // Web: blur fires before click; keep list briefly so pick can land
          setTimeout(() => {
            if (!picking.current) setFocused(false);
            picking.current = false;
          }, Platform.OS === 'web' ? 250 : 150);
        }}
      />
      {showList ? (
        <View style={styles.list}>
          {matches.map((item) => (
            <Pressable
              key={item}
              style={styles.item}
              onPressIn={() => pick(item)}
              // Web: prevent input blur so the click isn't lost
              {...(Platform.OS === 'web'
                ? {
                    onMouseDown: (e: { preventDefault?: () => void }) => {
                      e.preventDefault?.();
                      pick(item);
                    },
                  }
                : {})}>
              <Text style={styles.itemText}>{item}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { zIndex: 10 },
  list: {
    marginTop: -8,
    marginBottom: theme.space.md,
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
});
