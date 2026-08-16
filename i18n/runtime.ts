import { en, type Locale, type Translations } from './en';
import { sl } from './sl';
import { translateCategoryName, type CategoryLabels } from './categories';

const dictionaries: Record<Locale, Translations> = {
  en,
  sl: sl as Translations,
};

let runtimeLocale: Locale = 'en';

export function bindLocale(locale: Locale) {
  runtimeLocale = locale;
}

export function getLocale(): Locale {
  return runtimeLocale;
}

export function getT(): Translations {
  return dictionaries[runtimeLocale] ?? en;
}

export function getCategoryLabels(locale: Locale = runtimeLocale): CategoryLabels {
  return (dictionaries[locale] ?? en).categories as CategoryLabels;
}

export function categoryDisplayName(englishName: string, locale: Locale = runtimeLocale): string {
  return translateCategoryName(englishName, getCategoryLabels(locale));
}

export { dictionaries };
