/** Canonical category names stored in the database (English only). */

export const MAIN_CATEGORY_NAMES = [
  'Sport',
  'Culture',
  'Social',
  'Outdoor',
  'Food & Drink',
  'Education',
] as const;

export type MainCategoryName = (typeof MAIN_CATEGORY_NAMES)[number];

/** Subcategory (DB English name) → main category */
export const SUBCATEGORY_PARENT: Record<string, MainCategoryName> = {
  Football: 'Sport',
  Tennis: 'Sport',
  Basketball: 'Sport',
  Volleyball: 'Sport',
  Running: 'Sport',
  Cycling: 'Sport',
  Swimming: 'Sport',
  Gym: 'Sport',
  Concert: 'Culture',
  Theatre: 'Culture',
  Exhibition: 'Culture',
  Cinema: 'Culture',
  Party: 'Social',
  Meetup: 'Social',
  Networking: 'Social',
  Hiking: 'Outdoor',
  Picnic: 'Outdoor',
  Camping: 'Outdoor',
  Dinner: 'Food & Drink',
  Coffee: 'Food & Drink',
  Tasting: 'Food & Drink',
  Workshop: 'Education',
  Lecture: 'Education',
  Course: 'Education',
};

export const DEFAULT_SUBCATEGORIES = Object.keys(SUBCATEGORY_PARENT);

/** Non-English / alternate spellings → canonical English DB name (never shown as suggestions). */
export const CATEGORY_ALIASES: Record<string, string> = {
  soccer: 'Football',
  nogomet: 'Football',
  futbol: 'Football',
  tenis: 'Tennis',
  košarka: 'Basketball',
  kosarka: 'Basketball',
  odbojka: 'Volleyball',
  tek: 'Running',
  kolesarjenje: 'Cycling',
  plavanje: 'Swimming',
  telovadnica: 'Gym',
  fitnes: 'Gym',
  koncert: 'Concert',
  gledališče: 'Theatre',
  gledalisce: 'Theatre',
  razstava: 'Exhibition',
  kino: 'Cinema',
  zabava: 'Party',
  srečanje: 'Meetup',
  srecanje: 'Meetup',
  pohod: 'Hiking',
  piknik: 'Picnic',
  kampiranje: 'Camping',
  večerja: 'Dinner',
  vecerja: 'Dinner',
  kava: 'Coffee',
  degustacija: 'Tasting',
  delavnica: 'Workshop',
  predavanje: 'Lecture',
  tečaj: 'Course',
  tecaj: 'Course',
};

export type CategoryLabels = Record<string, string>;

export const CATEGORY_LABELS_EN: CategoryLabels = {
  Sport: 'Sport',
  Culture: 'Culture',
  Social: 'Social',
  Outdoor: 'Outdoor',
  'Food & Drink': 'Food & Drink',
  Education: 'Education',
  Football: 'Football',
  Tennis: 'Tennis',
  Basketball: 'Basketball',
  Volleyball: 'Volleyball',
  Running: 'Running',
  Cycling: 'Cycling',
  Swimming: 'Swimming',
  Gym: 'Gym',
  Concert: 'Concert',
  Theatre: 'Theatre',
  Exhibition: 'Exhibition',
  Cinema: 'Cinema',
  Party: 'Party',
  Meetup: 'Meetup',
  Networking: 'Networking',
  Hiking: 'Hiking',
  Picnic: 'Picnic',
  Camping: 'Camping',
  Dinner: 'Dinner',
  Coffee: 'Coffee',
  Tasting: 'Tasting',
  Workshop: 'Workshop',
  Lecture: 'Lecture',
  Course: 'Course',
};

export const CATEGORY_LABELS_SL: CategoryLabels = {
  Sport: 'Šport',
  Culture: 'Kultura',
  Social: 'Družabno',
  Outdoor: 'Na prostem',
  'Food & Drink': 'Hrana in pijača',
  Education: 'Izobraževanje',
  Football: 'Nogomet',
  Tennis: 'Tenis',
  Basketball: 'Košarka',
  Volleyball: 'Odbojka',
  Running: 'Tek',
  Cycling: 'Kolesarjenje',
  Swimming: 'Plavanje',
  Gym: 'Fitnes',
  Concert: 'Koncert',
  Theatre: 'Gledališče',
  Exhibition: 'Razstava',
  Cinema: 'Kino',
  Party: 'Zabava',
  Meetup: 'Srečanje',
  Networking: 'Networking',
  Hiking: 'Pohod',
  Picnic: 'Piknik',
  Camping: 'Kampiranje',
  Dinner: 'Večerja',
  Coffee: 'Kava',
  Tasting: 'Degustacija',
  Workshop: 'Delavnica',
  Lecture: 'Predavanje',
  Course: 'Tečaj',
};

export function isMainCategoryName(name: string) {
  const lower = name.trim().toLowerCase();
  return MAIN_CATEGORY_NAMES.some((m) => m.toLowerCase() === lower);
}

/** Map typed / localized / alias input → English DB category name (or null). */
export function resolveCategoryKey(input: string, labels: CategoryLabels = CATEGORY_LABELS_EN): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  if (isMainCategoryName(trimmed)) return null;

  for (const en of Object.keys(SUBCATEGORY_PARENT)) {
    if (en.toLowerCase() === lower) return en;
  }

  const alias = CATEGORY_ALIASES[lower];
  if (alias) return alias;

  for (const [en, label] of Object.entries(labels)) {
    if (label.toLowerCase() === lower && SUBCATEGORY_PARENT[en]) return en;
  }

  // Also accept the other locale's labels so switching language mid-form still works
  for (const pack of [CATEGORY_LABELS_EN, CATEGORY_LABELS_SL]) {
    for (const [en, label] of Object.entries(pack)) {
      if (label.toLowerCase() === lower && SUBCATEGORY_PARENT[en]) return en;
    }
  }

  return null;
}

export function translateCategoryName(englishName: string, labels: CategoryLabels): string {
  return labels[englishName] ?? englishName;
}
