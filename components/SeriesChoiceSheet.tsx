import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, Muted } from '@/components/ui';
import { theme } from '@/constants/theme';
import { useT } from '@/i18n';

type Props = {
  visible: boolean;
  kind: 'join' | 'decline';
  onClose: () => void;
  onJoinThis: () => void;
  onJoinFollow: () => void;
  onDeclineThis: () => void;
  onNotInterested: () => void;
};

/** First Join or first I can't come on a series. Each is asked once. */
export function SeriesChoiceSheet({
  visible,
  kind,
  onClose,
  onJoinThis,
  onJoinFollow,
  onDeclineThis,
  onNotInterested,
}: Props) {
  const t = useT();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>{t.events.seriesChoiceTitle}</Text>
          <Muted>{kind === 'join' ? t.events.joinChoicePrompt : t.events.declineChoicePrompt}</Muted>
          <View style={{ height: 12 }} />
          {kind === 'join' ? (
            <>
              <Button label={t.events.joinThisEvent} onPress={onJoinThis} />
              <View style={{ height: 8 }} />
              <Button label={t.events.joinAndFollow} variant="secondary" onPress={onJoinFollow} />
            </>
          ) : (
            <>
              <Button label={t.events.declineThisEvent} onPress={onDeclineThis} />
              <View style={{ height: 8 }} />
              <Button label={t.events.seriesNotInterested} variant="secondary" onPress={onNotInterested} />
            </>
          )}
          <View style={{ height: 8 }} />
          <Button label={t.common.cancel} variant="ghost" onPress={onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: 24,
  },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: 20,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: 8,
  },
});
