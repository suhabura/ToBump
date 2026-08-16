import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { en, type Locale, type Translations } from './en';
import { sl } from './sl';
import { resolveCategoryKey } from './categories';
import {
  bindLocale,
  categoryDisplayName,
  dictionaries,
  getCategoryLabels,
  getLocale,
  getT,
} from './runtime';

const STORAGE_KEY = 'tobump_locale';

export const LOCALES: { code: Locale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'sl', label: 'Slovenščina' },
];

export function resolveActivityCategoryKey(input: string, locale: Locale = getLocale()): string | null {
  return resolveCategoryKey(input, getCategoryLabels(locale));
}

type I18nContextValue = {
  locale: Locale;
  t: Translations;
  setLocale: (locale: Locale) => Promise<void>;
};

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

function normalizeLocale(value: unknown): Locale {
  if (value === 'sl' || value === 'en') return value;
  return 'en';
}

export function LocaleProvider({
  children,
  settingsLocale,
  onPersistLocale,
}: {
  children: React.ReactNode;
  settingsLocale?: string | null;
  onPersistLocale?: (locale: Locale) => Promise<void>;
}) {
  const [locale, setLocaleState] = useState<Locale>('en');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (stored) setLocaleState(normalizeLocale(stored));
    });
  }, []);

  useEffect(() => {
    if (settingsLocale) setLocaleState(normalizeLocale(settingsLocale));
  }, [settingsLocale]);

  useEffect(() => {
    bindLocale(locale);
  }, [locale]);

  const setLocale = useCallback(
    async (next: Locale) => {
      setLocaleState(next);
      bindLocale(next);
      await AsyncStorage.setItem(STORAGE_KEY, next);
      await onPersistLocale?.(next);
    },
    [onPersistLocale]
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      t: dictionaries[locale] ?? en,
      setLocale,
    }),
    [locale, setLocale]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useLocale() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useLocale must be used within LocaleProvider');
  return ctx;
}

export function useT(): Translations {
  return useLocale().t;
}

/** Static English fallback for non-React modules. Prefer useT() in UI. */
export const t = en;

export type { Locale, Translations };
export { en, sl, categoryDisplayName, getLocale, getT };
export { resolveCategoryKey } from './categories';
