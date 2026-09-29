import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { theme } from '@/constants/theme';

type Listener = (message: string | null) => void;

let listener: Listener | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

/** Short success notice. A new message replaces the current one. */
export function showToast(message: string, ms = 2500) {
  if (hideTimer) clearTimeout(hideTimer);
  listener?.(message);
  hideTimer = setTimeout(() => {
    listener?.(null);
    hideTimer = null;
  }, ms);
}

export function ToastHost() {
  const insets = useSafeAreaInsets();
  const [message, setMessage] = useState<string | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const generation = useRef(0);

  useEffect(() => {
    listener = (next) => {
      generation.current += 1;
      const mine = generation.current;
      opacity.stopAnimation();
      if (next) {
        setMessage(next);
        Animated.timing(opacity, {
          toValue: 1,
          duration: 180,
          useNativeDriver: Platform.OS !== 'web',
        }).start();
        return;
      }
      Animated.timing(opacity, {
        toValue: 0,
        duration: 180,
        useNativeDriver: Platform.OS !== 'web',
      }).start(() => {
        if (generation.current === mine) setMessage(null);
      });
    };
    return () => {
      listener = null;
    };
  }, [opacity]);

  if (!message) return null;

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      accessibilityRole="text"
      {...(Platform.OS === 'web' ? { role: 'status' as const } : {})}
      style={[styles.wrap, { bottom: insets.bottom + 72, opacity }]}>
      <Text style={styles.text}>{message}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 16,
    right: 16,
    alignItems: 'center',
    zIndex: 50,
  },
  text: {
    maxWidth: 360,
    backgroundColor: theme.colors.primaryDark,
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 20,
    textAlign: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
  },
});
