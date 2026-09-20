import { Alert, Platform } from 'react-native';

function nativeAlert(title: string, message?: string, buttons?: Parameters<typeof Alert.alert>[2]) {
  // Android (and some iOS list taps) drop Alert if it opens in the same tick as the press.
  setTimeout(() => Alert.alert(title, message, buttons), 50);
}

/** Message-only alert that works on web and native. */
export function showAlert(title: string, message?: string) {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.alert(message ? `${title}\n\n${message}` : title);
    return;
  }
  nativeAlert(title, message);
}

/** Confirm dialog whose confirm callback actually runs on web and native. */
export function confirmAction(opts: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    if (window.confirm(`${opts.title}\n\n${opts.message}`)) opts.onConfirm();
    return;
  }
  nativeAlert(opts.title, opts.message, [
    { text: opts.cancelLabel, style: 'cancel' },
    {
      text: opts.confirmLabel,
      style: opts.destructive ? 'destructive' : 'default',
      onPress: opts.onConfirm,
    },
  ]);
}
