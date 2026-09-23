import { useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Chip, Input, Muted } from '@/components/ui';
import { WeatherWeek } from '@/components/WeatherBadge';
import { DateTimeField } from '@/components/DateTimeField';
import { DateMultiField } from '@/components/DateMultiField';
import { LocationField } from '@/components/LocationField';
import { SuggestInput } from '@/components/SuggestInput';
import { FriendPicker } from '@/components/FriendPicker';
import {
  DEFAULT_SUBCATEGORIES,
  MAIN_CATEGORY_NAMES,
  ensureDefaultCategories,
  findCategoryId,
  saveActivity,
  type ActivityInput,
} from '@/lib/api';
import { dedupeProfilesByEmail } from '@/lib/friends';
import {
  clearSeriesFinanceSettings,
  ensureFundingExpenses,
  seriesKey,
  upsertSeriesFinanceSettings,
} from '@/lib/finance';
import {
  combineDayAndTime,
  firstOccurrence,
  formatDuration,
  formatFirstOccurrence,
  formatRecurrence,
  hydrateRules,
  isoWeekday,
  normalizeRules,
  ruleTimeAsDate,
  rulesFromLegacy,
  weekdayLong,
  weekdayShort,
  WEEKDAY_OPTIONS,
  type RecurrenceRule,
} from '@/lib/recurrence';
import { supabase } from '@/lib/supabase';
import type { Category, Enterprise, FinanceWhoPays, FundingMode, Privacy, Profile } from '@/lib/types';
import { displayName } from '@/lib/types';
import { categoryDisplayName, resolveActivityCategoryKey, useLocale, useT } from '@/i18n';
import { theme } from '@/constants/theme';

type Props = {
  userId: string;
  activityId?: string;
  /** Only the creator can assign co-editors (true for new events) */
  isCreator?: boolean;
  initial?: Partial<ActivityInput> & {
    invite_user_ids?: string[];
    editor_user_ids?: string[];
    group_id?: string | null;
    series_id?: string | null;
    funding_mode?: FundingMode | null;
    who_pays?: FinanceWhoPays | null;
    payer_group_id?: string | null;
    payer_user_ids?: string[];
  };
};

function parseInitialDate(value?: string | null) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function defaultDurationFromInitial(initial?: Props['initial']): number {
  if (initial?.duration_minutes && initial.duration_minutes > 0) return initial.duration_minutes;
  const s = parseInitialDate(initial?.starts_at);
  const e = parseInitialDate(initial?.ends_at);
  if (s && e && e > s) return Math.max(15, Math.round((e.getTime() - s.getTime()) / 60_000));
  return 90;
}

function initialRules(initial?: Props['initial']): RecurrenceRule[] {
  const fallback = defaultDurationFromInitial(initial);
  if (initial?.recurrence_rules?.length) return hydrateRules(initial.recurrence_rules, fallback);
  if (initial?.is_recurring && initial.starts_at) {
    const d = parseInitialDate(initial.starts_at);
    if (d && (initial as { recurrence_weekdays?: number[] }).recurrence_weekdays?.length) {
      return rulesFromLegacy(
        (initial as { recurrence_weekdays?: number[] }).recurrence_weekdays!,
        d.getHours(),
        d.getMinutes(),
        fallback
      );
    }
  }
  return [];
}

export function ActivityForm({ userId, activityId, initial, isCreator = true }: Props) {
  const router = useRouter();
  const t = useT();
  const { locale } = useLocale();
  const [title, setTitle] = useState(() => {
    const raw = initial?.title ?? '';
    const key = resolveActivityCategoryKey(raw);
    return key ? categoryDisplayName(key, locale) : raw;
  });
  const [startsAt, setStartsAt] = useState<Date | null>(parseInitialDate(initial?.starts_at));
  const [price, setPrice] = useState(
    initial?.finance_enabled && initial?.price != null ? String(initial.price) : ''
  );
  const [capacityRange, setCapacityRange] = useState(() => {
    const min = initial?.min_participants ?? null;
    const max = initial?.max_participants ?? null;
    if (min != null && max != null) return min !== max;
    return min != null;
  });
  const [desiredCapacity, setDesiredCapacity] = useState(() => {
    const min = initial?.min_participants ?? null;
    const max = initial?.max_participants ?? null;
    if (min != null && max != null && min === max) return String(min);
    if (max != null && min == null) return String(max);
    return '';
  });
  const [minCapacity, setMinCapacity] = useState(
    initial?.min_participants && initial.min_participants !== initial.max_participants
      ? String(initial.min_participants)
      : ''
  );
  const [maxCapacity, setMaxCapacity] = useState(() => {
    const min = initial?.min_participants ?? null;
    const max = initial?.max_participants ?? null;
    if (min != null && max != null && min !== max) return String(max);
    return '';
  });
  const [privacy, setPrivacy] = useState<Privacy>(() => {
    const p = initial?.privacy ?? 'invite';
    return p === 'friends_of_friends' ? 'invite' : p;
  });
  const [enterpriseId, setEnterpriseId] = useState<string | null>(initial?.enterprise_id ?? null);
  const [venueText, setVenueText] = useState(initial?.venue_text ?? '');
  const [venueLatitude, setVenueLatitude] = useState<number | null>(initial?.venue_latitude ?? null);
  const [venueLongitude, setVenueLongitude] = useState<number | null>(initial?.venue_longitude ?? null);
  const [geoLocation, setGeoLocation] = useState(
    Boolean(
      initial?.enterprise_id ||
        (initial?.venue_latitude != null && initial?.venue_longitude != null)
    )
  );
  const [matchedCategoryId, setMatchedCategoryId] = useState<string | null>(initial?.category_id ?? null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [enterprises, setEnterprises] = useState<Enterprise[]>([]);
  const [friends, setFriends] = useState<Profile[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(initial?.group_id ?? null);
  const [groupMembers, setGroupMembers] = useState<Profile[]>([]);
  const [inviteIds, setInviteIds] = useState<string[]>(initial?.invite_user_ids ?? []);
  const [editorIds, setEditorIds] = useState<string[]>(initial?.editor_user_ids ?? []);
  const [showEditors, setShowEditors] = useState(Boolean(initial?.editor_user_ids?.length));
  const [recurrenceMode, setRecurrenceMode] = useState<'once' | 'weekly' | 'dates'>(() => {
    const weekly =
      Boolean(initial?.is_recurring) &&
      ((initial?.recurrence_rules?.length ?? 0) > 0 ||
        ((initial as { recurrence_weekdays?: number[] } | undefined)?.recurrence_weekdays?.length ?? 0) > 0);
    if (weekly) return 'weekly';
    if ((initial?.recurrence_dates?.length ?? 0) >= 2) return 'dates';
    if (initial?.is_recurring) return 'weekly';
    return 'once';
  });
  const isRecurring = recurrenceMode !== 'once';
  const isDateSeries = recurrenceMode === 'dates';
  const lockedDates = useMemo(
    () => Array.from(new Set(initial?.recurrence_dates ?? [])).sort(),
    [initial?.recurrence_dates]
  );
  const [pickedDates, setPickedDates] = useState<string[]>(() =>
    Array.from(new Set(initial?.recurrence_dates ?? [])).sort()
  );
  const [extraDates, setExtraDates] = useState<string[]>(() => {
    const weekly =
      Boolean(initial?.is_recurring) &&
      ((initial?.recurrence_rules?.length ?? 0) > 0 ||
        ((initial as { recurrence_weekdays?: number[] } | undefined)?.recurrence_weekdays?.length ?? 0) > 0);
    return weekly ? Array.from(new Set(initial?.recurrence_dates ?? [])).sort() : [];
  });
  const [financeEnabled, setFinanceEnabled] = useState(Boolean(initial?.finance_enabled));
  const [showWeather, setShowWeather] = useState(Boolean(initial?.show_weather));
  const [moreOpen, setMoreOpen] = useState(
    () =>
      Boolean(initial?.is_recurring) ||
      (initial?.recurrence_dates?.length ?? 0) >= 2 ||
      Boolean(initial?.finance_enabled) ||
      Boolean(initial?.show_weather) ||
      initial?.min_participants != null ||
      initial?.max_participants != null ||
      Boolean(initial?.editor_user_ids?.length)
  );
  const [fundingMode, setFundingMode] = useState<FundingMode>(() => {
    const raw = initial?.funding_mode;
    if (raw === 'annual' || raw === 'fixed') return 'fixed';
    if (raw === 'per_event') return 'per_event';
    return 'per_event';
  });
  const [rules, setRules] = useState<RecurrenceRule[]>(() => initialRules(initial));
  const [seriesFromDate, setSeriesFromDate] = useState<Date>(() => {
    const s = parseInitialDate(initial?.starts_at);
    const d = s ? new Date(s) : new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [recurrenceUntil, setRecurrenceUntil] = useState<Date | null>(() => {
    const raw = (initial as { recurrence_until?: string | null } | undefined)?.recurrence_until;
    if (!raw) return null;
    const d = new Date(`${raw}T12:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  });
  const [durationMinutes, setDurationMinutes] = useState(() => defaultDurationFromInitial(initial));
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function changeExtraDates(next: string[]) {
    setExtraDates(next);
    setRecurrenceUntil((current) => {
      if (!current) return current;
      const untilDay = formatDay(current);
      let later = untilDay;
      for (const day of next) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day > later) later = day;
      }
      if (later === untilDay) return current;
      const moved = new Date(`${later}T12:00:00`);
      return Number.isNaN(moved.getTime()) ? current : moved;
    });
  }

  // Only English canonical names from seed + DB English rows — show localized labels once
  const activitySuggestions = useMemo(() => {
    const englishKeys = new Set(DEFAULT_SUBCATEGORIES);
    for (const c of categories) {
      if (MAIN_CATEGORY_NAMES.some((m) => m.toLowerCase() === c.name.toLowerCase())) continue;
      if (DEFAULT_SUBCATEGORIES.some((k) => k.toLowerCase() === c.name.toLowerCase())) {
        englishKeys.add(DEFAULT_SUBCATEGORIES.find((k) => k.toLowerCase() === c.name.toLowerCase())!);
      }
    }
    return Array.from(englishKeys).map((key) => categoryDisplayName(key, locale));
  }, [categories, locale]);

  const computedFirst = useMemo(() => {
    if (recurrenceMode !== 'weekly') return null;
    return firstOccurrence(seriesFromDate, rules, { now: new Date(), until: recurrenceUntil });
  }, [recurrenceMode, seriesFromDate, rules, recurrenceUntil]);

  useEffect(() => {
    const key = resolveActivityCategoryKey(title, locale);
    if (key) setTitle(categoryDisplayName(key, locale));
    // Re-label when UI language changes; ignore free-text that isn't a known category
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  function onVenueLocationChange(next: {
    address: string;
    latitude: number | null;
    longitude: number | null;
  }) {
    setEnterpriseId(null);
    setVenueText(next.address);
    setVenueLatitude(next.latitude);
    setVenueLongitude(next.longitude);
  }

  function onVenueTextChange(text: string) {
    setVenueText(text);
    if (enterpriseId || venueLatitude != null || venueLongitude != null) {
      setEnterpriseId(null);
      setVenueLatitude(null);
      setVenueLongitude(null);
    }
  }

  function clearVenue() {
    setEnterpriseId(null);
    setVenueText('');
    setVenueLatitude(null);
    setVenueLongitude(null);
    setShowWeather(false);
  }

  useEffect(() => {
    if (!enterpriseId || venueText.trim()) return;
    const ent = enterprises.find((e) => e.id === enterpriseId);
    if (ent) {
      const label = ent.address?.trim() ? `${ent.name} · ${ent.address.trim()}` : ent.name;
      setVenueText(label);
      setVenueLatitude(ent.latitude ?? null);
      setVenueLongitude(ent.longitude ?? null);
    }
  }, [enterpriseId, enterprises, venueText]);

  useEffect(() => {
    (async () => {
      await ensureDefaultCategories();
      const [{ data: cats }, { data: ents }, groupsRes] = await Promise.all([
        supabase.from('categories').select('*').order('name'),
        supabase.from('enterprises').select('*').order('name'),
        supabase.from('friend_groups').select('id, name').eq('created_by', userId).order('name'),
      ]);
      setCategories((cats as Category[]) ?? []);
      setEnterprises((ents as Enterprise[]) ?? []);
      setGroups((groupsRes.data as { id: string; name: string }[]) ?? []);

      const { data: fr } = await supabase
        .from('friendships')
        .select('*')
        .eq('status', 'accepted')
        .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`);
      const otherIds = Array.from(
        new Set(
          (fr ?? []).map((f: { from_user_id: string; to_user_id: string }) =>
            f.from_user_id === userId ? f.to_user_id : f.from_user_id
          )
        )
      );
      if (otherIds.length) {
        const { data: profiles } = await supabase.from('profiles').select('*').in('id', otherIds);
        setFriends(dedupeProfilesByEmail((profiles as Profile[]) ?? []));
      }
    })();
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!selectedGroupId) {
        setGroupMembers([]);
        return;
      }
      const { data } = await supabase
        .from('friend_group_members')
        .select('user_id')
        .eq('group_id', selectedGroupId);
      if (cancelled) return;
      const ids = Array.from(
        new Set((data ?? []).map((m: { user_id: string }) => m.user_id).filter((id) => id !== userId))
      );
      if (!ids.length) {
        setGroupMembers([]);
        return;
      }
      const { data: profiles } = await supabase.from('profiles').select('*').in('id', ids);
      if (cancelled) return;
      setGroupMembers(
        dedupeProfilesByEmail((profiles as Profile[]) ?? []).sort((a, b) =>
          displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' })
        )
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedGroupId, userId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const id = await findCategoryId(title);
      if (cancelled) return;
      setMatchedCategoryId(id);
      if (!id) {
        setEnterpriseId(null);
        return;
      }
      setEnterpriseId((prev) => {
        if (!prev) return null;
        const ent = enterprises.find((e) => e.id === prev);
        if (!ent?.category_id) return prev;
        if (ent.category_id === id) return prev;
        const sub = categories.find((c) => c.id === id);
        const parentId = sub?.parent_id ?? null;
        if (parentId && ent.category_id === parentId) return prev;
        const entCat = categories.find((c) => c.id === ent.category_id);
        if (parentId && entCat?.parent_id === parentId) return prev;
        return null;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [title, enterprises, categories]);

  function setVenueMode(maps: boolean) {
    setGeoLocation(maps);
    if (!maps) {
      setEnterpriseId(null);
      setVenueLatitude(null);
      setVenueLongitude(null);
      setShowWeather(false);
    }
  }

  function setCapacityMode(range: boolean) {
    setCapacityRange(range);
    if (range) {
      if (!maxCapacity.trim() && desiredCapacity.trim()) {
        setMaxCapacity(desiredCapacity);
      }
    } else if (!desiredCapacity.trim()) {
      setDesiredCapacity(maxCapacity || minCapacity);
    }
  }

  function toggleWeekday(day: number) {
    setRules((prev) => {
      if (prev.some((r) => r.weekday === day)) {
        return prev.filter((r) => r.weekday !== day);
      }
      const template = prev[0];
      const hour = template?.hour ?? startsAt?.getHours() ?? 18;
      const minute = template?.minute ?? (startsAt ? (Math.round(startsAt.getMinutes() / 15) * 15) % 60 : 0);
      const duration = template?.duration_minutes ?? durationMinutes;
      return normalizeRules([...prev, { weekday: day, hour, minute, duration_minutes: duration }]);
    });
  }

  function patchRule(weekday: number, patch: Partial<RecurrenceRule>) {
    setRules((prev) =>
      normalizeRules(prev.map((r) => (r.weekday === weekday ? { ...r, ...patch } : r)))
    );
  }

  function setRecurringMode(mode: 'once' | 'weekly' | 'dates') {
    setRecurrenceMode(mode);
    if (mode !== 'once') setMoreOpen(true);
    if (mode === 'once') {
      setRules([]);
      setRecurrenceUntil(null);
      setFundingMode('per_event');
    }
    if (mode !== 'weekly') setRules([]);
    if (mode === 'dates' && !startsAt) {
      const d = new Date();
      d.setHours(18, 0, 0, 0);
      setStartsAt(d);
    }
  }

  async function onSave() {
    setFormError(null);
    if (!title.trim()) {
      setFormError(t.form.needActivityStart);
      return;
    }
    const normalized = recurrenceMode === 'weekly' ? normalizeRules(rules) : [];
    if (recurrenceMode === 'weekly' && normalized.length === 0) {
      setFormError(t.form.needWeekday);
      return;
    }
    if (recurrenceMode === 'weekly' && normalized.some((r) => !r.duration_minutes || r.duration_minutes < 15)) {
      setFormError(t.form.needDurationPerDay);
      return;
    }
    if (recurrenceMode !== 'weekly' && durationMinutes < 15) {
      setFormError(t.form.minDuration);
      return;
    }

    let startToSave = startsAt;
    if (isDateSeries) {
      const days = [...pickedDates].sort();
      if (!activityId && days.length < 2) {
        setFormError(t.form.needDates);
        return;
      }
      const seed = startsAt ?? new Date();
      const orig = activityId ? parseInitialDate(initial?.starts_at) : null;
      const day = orig ? formatDay(orig) : days[0];
      if (!day) {
        setFormError(t.form.needDates);
        return;
      }
      startToSave = combineDayAndTime(day, seed.getHours(), seed.getMinutes());
    } else if (recurrenceMode === 'weekly') {
      if (!recurrenceUntil) {
        setFormError(t.form.needSeriesEnd);
        return;
      }
      const first = firstOccurrence(seriesFromDate, normalized, {
        now: new Date(),
        until: recurrenceUntil,
      });
      if (!first) {
        setFormError(t.form.needFirstOccurrence);
        return;
      }
      startToSave = first;
      const untilDay = formatDay(recurrenceUntil);
      if (untilDay < formatDay(startToSave)) {
        setFormError(t.form.seriesEndBeforeStart);
        return;
      }
    } else if (!startToSave) {
      setFormError(t.form.needActivityStart);
      return;
    }

    if (startToSave.getTime() < Date.now() - 30_000) {
      setFormError(t.form.pastNotAllowed);
      return;
    }

    if (privacy === 'group' && !selectedGroupId) {
      setFormError(t.form.needGroup);
      return;
    }

    const priceTrim = financeEnabled ? price.trim() : '';
    if (financeEnabled) {
      if (priceTrim === '' || Number.isNaN(Number(priceTrim)) || Number(priceTrim) < 0) {
        setFormError(t.form.needPrice);
        return;
      }
    }
    const priceNum = financeEnabled ? Number(priceTrim) || 0 : null;
    const modeToSave: FundingMode = isRecurring ? fundingMode : 'per_event';

    function parseOptionalCount(raw: string): number | null | 'invalid' {
      const v = raw.trim();
      if (!v) return null;
      if (!/^\d+$/.test(v) || Number(v) < 1) return 'invalid';
      return Number(v);
    }
    let minNum: number | null | 'invalid' = null;
    let maxNum: number | null | 'invalid' = null;
    if (capacityRange) {
      minNum = parseOptionalCount(minCapacity);
      maxNum = parseOptionalCount(maxCapacity);
    } else {
      const exact = parseOptionalCount(desiredCapacity);
      minNum = exact;
      maxNum = exact;
    }
    if (minNum === 'invalid' || maxNum === 'invalid') {
      setFormError(t.form.needCapacity);
      return;
    }
    if (minNum == null) {
      setFormError(t.form.needPeople);
      return;
    }
    if (maxNum != null && minNum > maxNum) {
      setFormError(t.form.capacityMinMax);
      return;
    }
    const inviteeCount =
      privacy === 'friends'
        ? friends.filter((f) => f.id !== userId).length
        : privacy === 'group'
          ? groupMembers.filter((p) => p.id !== userId).length
          : inviteIds.filter((id) => id !== userId).length;
    if (inviteeCount + 1 < minNum) {
      setFormError(t.form.needMorePeople(minNum - (inviteeCount + 1)));
      return;
    }

    if (!enterpriseId && !venueText.trim()) {
      setFormError(t.form.needVenue);
      return;
    }

    setLoading(true);
    try {
      const categoryKey = resolveActivityCategoryKey(title, locale);
      // Prefer already-resolved category; only one lookup if still pending.
      const category_id = categoryKey
        ? matchedCategoryId ?? (await findCategoryId(categoryKey))
        : null;
      const titleToSave = (categoryKey ?? title.trim()).trim();
      if (!titleToSave) {
        setFormError(t.form.needActivityStart);
        return;
      }

      const id = await saveActivity(
        userId,
        {
          title: titleToSave,
          category_id,
          starts_at: startToSave.toISOString(),
          ends_at: null,
          duration_minutes: recurrenceMode === 'weekly'
            ? normalized.find((r) => r.weekday === isoWeekday(startToSave))?.duration_minutes ??
              durationMinutes
            : durationMinutes,
          price: priceNum,
          min_participants: minNum,
          max_participants: maxNum,
          privacy,
          enterprise_id: geoLocation && category_id ? enterpriseId : null,
          venue_text: venueText.trim() || null,
          venue_latitude: geoLocation ? venueLatitude : null,
          venue_longitude: geoLocation ? venueLongitude : null,
          group_id: selectedGroupId,
          invite_user_ids: inviteIds,
          editor_user_ids: isCreator ? editorIds : undefined,
          is_recurring: isRecurring,
          finance_enabled: financeEnabled,
          show_weather: geoLocation && venueLatitude != null && venueLongitude != null && showWeather,
          recurrence_rules: recurrenceMode === 'weekly' ? normalized : [],
          recurrence_until: recurrenceMode === 'weekly' && recurrenceUntil ? formatDay(recurrenceUntil) : null,
          recurrence_dates:
            recurrenceMode === 'dates'
              ? [...pickedDates].sort()
              : recurrenceMode === 'weekly'
                ? [...extraDates].sort()
                : [],
        },
        activityId
      );

      const sid = seriesKey({ id, series_id: initial?.series_id ?? null });
      if (financeEnabled) {
        await upsertSeriesFinanceSettings({
          seriesId: sid,
          fundingMode: modeToSave === 'annual' ? 'fixed' : modeToSave,
          amount: priceNum ?? 0,
          whoPays: 'selected',
          payerGroupId: null,
          payerIds: [],
          userId,
        });
        try {
          await ensureFundingExpenses({
            activity: {
              id,
              series_id: initial?.series_id ?? null,
              created_by: userId,
              finance_enabled: true,
              title: titleToSave,
              starts_at: startToSave.toISOString(),
            },
            settings: {
              series_id: sid,
              funding_mode: modeToSave === 'annual' ? 'fixed' : modeToSave,
              amount: priceNum ?? 0,
              who_pays: 'selected',
              payer_group_id: null,
              payer_ids: [],
              currency: 'EUR',
              updated_by: userId,
              updated_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
          });
        } catch {
          /* fees created when someone first attends / Finance tab syncs */
        }
      } else {
        try {
          await clearSeriesFinanceSettings(sid);
        } catch {
          /* optional table */
        }
      }

      router.replace(`/activity/${id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : t.common.error;
      const friendly =
        /activities_privacy_check|friends_of_friends/i.test(msg)
          ? t.form.fofDbFix
          : msg;
      setFormError(friendly);
      Alert.alert(t.common.error, friendly);
    } finally {
      setLoading(false);
    }
  }

  const req = (label: string) => `${label} *`;

  return (
    <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
      {formError ? <Text style={styles.error}>{formError}</Text> : null}
      <SuggestInput
        label={req(t.form.activity)}
        value={title}
        onChangeText={setTitle}
        suggestions={activitySuggestions}
        placeholder={t.form.activityPlaceholder}
        resolveAlias={(text) => {
          const key = resolveActivityCategoryKey(text, locale);
          return key ? categoryDisplayName(key, locale) : null;
        }}
      />

      <Text style={styles.section}>{req(t.form.neededCount)}</Text>
      <View style={styles.row}>
        <Chip label={t.form.capacityExact} active={!capacityRange} onPress={() => setCapacityMode(false)} />
        <Chip label={t.form.capacityRangeToggle} active={capacityRange} onPress={() => setCapacityMode(true)} />
      </View>
      {capacityRange ? (
        <View style={styles.capacityRow}>
          <View style={{ flex: 1 }}>
            <Input
              label={t.form.minCapacity}
              value={minCapacity}
              onChangeText={(v) => setMinCapacity(v.replace(/[^\d]/g, ''))}
              keyboardType="number-pad"
              placeholder="—"
            />
          </View>
          <View style={{ flex: 1 }}>
            <Input
              label={t.form.maxCapacity}
              value={maxCapacity}
              onChangeText={(v) => setMaxCapacity(v.replace(/[^\d]/g, ''))}
              keyboardType="number-pad"
              placeholder="—"
            />
          </View>
        </View>
      ) : (
        <Input
          label={t.form.desiredCapacity}
          value={desiredCapacity}
          onChangeText={(v) => setDesiredCapacity(v.replace(/[^\d]/g, ''))}
          keyboardType="number-pad"
          placeholder="—"
        />
      )}
      <Muted>{t.form.capacityHint}</Muted>

      <Text style={styles.section}>{req(t.events.venue)}</Text>
      <View style={styles.row}>
        <Chip label={t.form.venueManual} active={!geoLocation} onPress={() => setVenueMode(false)} />
        <Chip label={t.form.addGeoLocation} active={geoLocation} onPress={() => setVenueMode(true)} />
      </View>
      {geoLocation ? (
        <LocationField
          label={t.form.geoSearch}
          address={venueText}
          latitude={venueLatitude}
          longitude={venueLongitude}
          showMyLocation={false}
          showSelectionCard={false}
          onChange={onVenueLocationChange}
          onClear={venueText.trim() || venueLatitude != null ? clearVenue : undefined}
        />
      ) : (
        <Input
          label={t.form.venueName}
          value={venueText}
          onChangeText={onVenueTextChange}
          placeholder={t.form.venuePlaceholder}
        />
      )}

      {recurrenceMode === 'once' ? (
        <View>
          <Text style={styles.section}>{req(t.form.when)}</Text>
          <DateTimeField
            label={req(t.events.starts)}
            value={startsAt}
            onChange={setStartsAt}
            minimumDate={new Date()}
          />
          <View style={{ marginBottom: theme.space.md }}>
            <Text style={styles.durationLabel}>{req(t.form.duration)}</Text>
            <View style={styles.durationRow}>
              <View style={styles.durationBlock}>
                <Chip label="−1h" active={false} onPress={() => setDurationMinutes((m) => Math.max(15, m - 60))} />
                <Chip label="−30m" active={false} onPress={() => setDurationMinutes((m) => Math.max(15, m - 30))} />
                <Chip label="−15m" active={false} onPress={() => setDurationMinutes((m) => Math.max(15, m - 15))} />
                <Text style={styles.durationValue}>{formatDuration(durationMinutes)}</Text>
                <Chip label="+15m" active={false} onPress={() => setDurationMinutes((m) => m + 15)} />
                <Chip label="+30m" active={false} onPress={() => setDurationMinutes((m) => m + 30)} />
                <Chip label="+1h" active={false} onPress={() => setDurationMinutes((m) => m + 60)} />
              </View>
            </View>
          </View>
        </View>
      ) : null}

      <Text style={styles.section}>{req(t.form.whoInvite)}</Text>
      {activityId && isRecurring ? <Muted>{t.events.seriesInviteEditHint}</Muted> : null}
      <View style={styles.row}>
        {(
          [
            { key: 'invite' as const, label: t.events.inviteOnly },
            { key: 'group' as const, label: t.events.group },
            { key: 'friends' as const, label: t.events.friendsOnly },
          ] as const
        ).map((p) => (
          <Chip
            key={p.key}
            label={p.label}
            active={privacy === p.key}
            onPress={() => setPrivacy(p.key)}
          />
        ))}
      </View>

      {privacy === 'invite' ? (
        <View>
          <Text style={styles.section}>{req(t.form.selectFriends)}</Text>
          {friends.length === 0 ? <Muted>{t.form.acceptFriendsHint}</Muted> : null}
          <FriendPicker
            friends={friends}
            selectedIds={inviteIds}
            onChange={setInviteIds}
            label={t.form.selectFriends}
            placeholder={t.form.searchFriends}
            emptyHint={t.form.noFriends}
          />
        </View>
      ) : null}

      {privacy === 'friends' ? (
        <Muted>{t.form.allFriendsInvited(friends.length)}</Muted>
      ) : null}

      {privacy === 'group' ? (
        <View>
          <Text style={styles.section}>{req(t.form.selectGroup)}</Text>
          {groups.length === 0 ? (
            <Muted>{t.form.noGroups}</Muted>
          ) : (
            <View style={styles.rowWrap}>
              {groups.map((g) => (
                <Chip
                  key={g.id}
                  label={g.name}
                  active={selectedGroupId === g.id}
                  onPress={() => setSelectedGroupId(g.id)}
                />
              ))}
            </View>
          )}
          {selectedGroupId && groupMembers.length ? (
            <View style={{ marginTop: 8, gap: 6 }}>
              <Muted>{t.form.groupMembers}</Muted>
              <View style={styles.rowWrap}>
                {groupMembers.map((p) => (
                  <Chip key={p.id} label={displayName(p)} active onPress={() => {}} />
                ))}
              </View>
            </View>
          ) : selectedGroupId ? (
            <Muted>{t.form.groupEmpty}</Muted>
          ) : null}
          {!activityId ? (
            <Button label={t.form.manageGroups} variant="secondary" onPress={() => router.push('/groups')} />
          ) : null}
        </View>
      ) : null}

      <Text style={[styles.link, { marginTop: 8, marginBottom: 8 }]} onPress={() => setMoreOpen((open) => !open)}>
        {moreOpen ? t.form.moreHide : t.form.more}
      </Text>

      {moreOpen ? (
      <View>
      <Text style={styles.section}>{req(t.form.recurrence)}</Text>
      {activityId ? (
        <Muted>
          {recurrenceMode === 'dates'
            ? t.events.dates
            : recurrenceMode === 'weekly'
              ? t.events.weekly
              : t.events.once}
        </Muted>
      ) : (
        <View style={styles.row}>
          <Chip label={t.events.once} active={recurrenceMode === 'once'} onPress={() => setRecurringMode('once')} />
          <Chip label={t.events.weekly} active={recurrenceMode === 'weekly'} onPress={() => setRecurringMode('weekly')} />
          <Chip label={t.events.dates} active={recurrenceMode === 'dates'} onPress={() => setRecurringMode('dates')} />
        </View>
      )}
      {recurrenceMode === 'dates' ? (
        <View>
          {activityId ? (
            <View>
              <Muted>{t.form.addDatesHint}</Muted>
              <DateMultiField selected={pickedDates} onChange={setPickedDates} lockedDays={lockedDates} />
              <Muted>{t.form.datesPicked(pickedDates.length)}</Muted>
            </View>
          ) : (
            <View>
              <Muted>{t.form.datesHint}</Muted>
              <DateMultiField selected={pickedDates} onChange={setPickedDates} />
              <Muted>{t.form.datesPicked(pickedDates.length)}</Muted>
            </View>
          )}
          <DateTimeField
            label={req(t.form.timeForDates)}
            value={startsAt}
            onChange={setStartsAt}
            mode="time"
            minimumDate={new Date(2000, 0, 1)}
          />
          <View style={{ marginBottom: theme.space.md }}>
            <Text style={styles.durationLabel}>{req(t.form.duration)}</Text>
            <View style={styles.durationRow}>
              <View style={styles.durationBlock}>
                <Chip label="−1h" active={false} onPress={() => setDurationMinutes((m) => Math.max(15, m - 60))} />
                <Chip label="−30m" active={false} onPress={() => setDurationMinutes((m) => Math.max(15, m - 30))} />
                <Chip label="−15m" active={false} onPress={() => setDurationMinutes((m) => Math.max(15, m - 15))} />
                <Text style={styles.durationValue}>{formatDuration(durationMinutes)}</Text>
                <Chip label="+15m" active={false} onPress={() => setDurationMinutes((m) => m + 15)} />
                <Chip label="+30m" active={false} onPress={() => setDurationMinutes((m) => m + 30)} />
                <Chip label="+1h" active={false} onPress={() => setDurationMinutes((m) => m + 60)} />
              </View>
            </View>
          </View>
        </View>
      ) : recurrenceMode === 'weekly' ? (
        <View>
          <Muted>{t.form.recurrenceHint}</Muted>
          <Text style={styles.section}>{t.form.daysAndSlots}</Text>
          <View style={styles.rowWrap}>
            {WEEKDAY_OPTIONS.map((d) => (
              <Chip
                key={d.value}
                label={weekdayShort(d.value, locale)}
                active={rules.some((r) => r.weekday === d.value)}
                onPress={() => toggleWeekday(d.value)}
              />
            ))}
          </View>
          {rules.map((r) => (
            <View key={r.weekday} style={styles.slotCard}>
              <Text style={styles.ruleDay}>{weekdayLong(r.weekday, locale)}</Text>
              <View style={styles.slotRow}>
                <View style={styles.slotTime}>
                  <DateTimeField
                    label={t.form.start}
                    value={ruleTimeAsDate(r)}
                    mode="time"
                    onChange={(d) => {
                      if (!d) return;
                      patchRule(r.weekday, {
                        hour: d.getHours(),
                        minute: (Math.round(d.getMinutes() / 15) * 15) % 60,
                      });
                    }}
                    containerStyle={{ marginBottom: 0 }}
                  />
                </View>
                <View style={styles.slotDuration}>
                  <Text style={styles.durationLabel}>{t.form.duration}</Text>
                  <View style={styles.durationBlock}>
                    <Chip
                      label="−1h"
                      active={false}
                      onPress={() => patchRule(r.weekday, { duration_minutes: Math.max(15, r.duration_minutes - 60) })}
                    />
                    <Chip
                      label="−30m"
                      active={false}
                      onPress={() => patchRule(r.weekday, { duration_minutes: Math.max(15, r.duration_minutes - 30) })}
                    />
                    <Chip
                      label="−15m"
                      active={false}
                      onPress={() => patchRule(r.weekday, { duration_minutes: Math.max(15, r.duration_minutes - 15) })}
                    />
                    <Text style={styles.durationValue}>{formatDuration(r.duration_minutes)}</Text>
                    <Chip
                      label="+15m"
                      active={false}
                      onPress={() => patchRule(r.weekday, { duration_minutes: r.duration_minutes + 15 })}
                    />
                    <Chip
                      label="+30m"
                      active={false}
                      onPress={() => patchRule(r.weekday, { duration_minutes: r.duration_minutes + 30 })}
                    />
                    <Chip
                      label="+1h"
                      active={false}
                      onPress={() => patchRule(r.weekday, { duration_minutes: r.duration_minutes + 60 })}
                    />
                  </View>
                </View>
              </View>
            </View>
          ))}
          {rules.length ? <Muted>{formatRecurrence(rules, locale)}</Muted> : null}

          <DateTimeField
            label={req(t.form.firstOccurrence)}
            value={seriesFromDate}
            mode="date"
            onChange={(d) => {
              if (!d) return;
              const next = new Date(d);
              next.setHours(0, 0, 0, 0);
              setSeriesFromDate(next);
            }}
            minimumDate={new Date()}
          />
          {computedFirst ? (
            <Muted>
              {t.form.firstOccurrenceComputed(formatFirstOccurrence(computedFirst, locale))}
              {` · ${formatDuration(
                rules.find((r) => r.weekday === isoWeekday(computedFirst))?.duration_minutes ?? durationMinutes
              )}`}
            </Muted>
          ) : rules.length ? (
            <Muted>{t.form.needFirstOccurrence}</Muted>
          ) : null}

          <DateTimeField
            label={req(t.form.seriesEnds)}
            value={recurrenceUntil}
            onChange={setRecurrenceUntil}
            mode="date"
            minimumDate={computedFirst ?? seriesFromDate}
          />
          {activityId ? (
            <View>
              <Text style={styles.section}>{t.form.addExtraDate}</Text>
              <Muted>{t.form.addExtraDateHint}</Muted>
              <DateMultiField selected={extraDates} onChange={changeExtraDates} />
            </View>
          ) : null}
        </View>
      ) : null}

      {geoLocation && venueLatitude != null && venueLongitude != null ? (
        <>
          <Text style={styles.section}>{t.form.weather}</Text>
          <Muted>{t.form.weatherHint}</Muted>
          <View style={styles.row}>
            <Chip label={t.form.weatherOff} active={!showWeather} onPress={() => setShowWeather(false)} />
            <Chip label={t.form.weatherOn} active={showWeather} onPress={() => setShowWeather(true)} />
          </View>
          {showWeather ? (
            <WeatherWeek
              latitude={venueLatitude}
              longitude={venueLongitude}
              locale={locale}
              eventDay={startsAt ? formatDay(startsAt) : null}
              startsAt={startsAt ? startsAt.toISOString() : null}
            />
          ) : null}
        </>
      ) : null}

      <Text style={styles.section}>{t.form.finance}</Text>
      {financeEnabled ? <Muted>{t.form.financeHint}</Muted> : null}
      <View style={styles.row}>
        <Chip
          label={t.form.financeOff}
          active={!financeEnabled}
          onPress={() => setFinanceEnabled(false)}
        />
        <Chip
          label={t.form.financeOn}
          active={financeEnabled}
          onPress={() => setFinanceEnabled(true)}
        />
      </View>
      {financeEnabled ? (
        <View style={{ marginTop: 12, gap: 8 }}>
          <Muted>{t.form.fundingMode}</Muted>
          <View style={styles.rowWrap}>
            <Chip
              label={t.form.payPerEvent}
              active={fundingMode === 'per_event'}
              onPress={() => setFundingMode('per_event')}
            />
            {isRecurring ? (
              <Chip
                label={t.form.payFixed}
                active={fundingMode === 'fixed' || fundingMode === 'annual'}
                onPress={() => setFundingMode('fixed')}
              />
            ) : null}
          </View>
          <Input
            label={
              fundingMode === 'fixed' || fundingMode === 'annual'
                ? t.form.priceFixed
                : t.form.pricePerEvent
            }
            value={price}
            onChangeText={setPrice}
            keyboardType="decimal-pad"
            placeholder="0"
          />
          <Muted>
            {fundingMode === 'fixed' || fundingMode === 'annual'
              ? t.form.priceFixedHint
              : t.form.pricePerEventHint}
          </Muted>
          <Muted>{t.form.payersAreAttendees}</Muted>
        </View>
      ) : null}

      {isCreator ? (
        <View style={{ marginTop: 16 }}>
          {!showEditors ? (
            <Text style={styles.link} onPress={() => setShowEditors(true)}>
              {t.form.addEditors}
            </Text>
          ) : (
            <View>
              <Text style={styles.section}>{t.form.editors}</Text>
              <Muted>{t.form.editorsHint}</Muted>
              <FriendPicker
                friends={friends}
                selectedIds={editorIds}
                onChange={setEditorIds}
                label={t.form.editors}
                placeholder={t.form.searchFriends}
                emptyHint={t.form.noFriends}
              />
              <Text
                style={[styles.link, { marginTop: 8 }]}
                onPress={() => {
                  setShowEditors(false);
                  setEditorIds(initial?.editor_user_ids ?? []);
                }}>
                {t.common.cancel}
              </Text>
            </View>
          )}
        </View>
      ) : null}
      </View>
      ) : null}

      <View style={{ height: 16 }} />
      <Button label={t.events.save} onPress={onSave} loading={loading} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    padding: theme.space.md,
    paddingBottom: 48,
    backgroundColor: theme.colors.background,
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  section: {
    fontWeight: '700',
    marginTop: 8,
    marginBottom: 8,
    color: theme.colors.text,
    width: '100%',
    alignSelf: 'stretch',
  },
  row: { flexDirection: 'row', marginBottom: 12, flexWrap: 'wrap', alignItems: 'center', width: '100%' },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12, gap: 4 },
  capacityRow: { flexDirection: 'row', gap: 12 },
  ruleCard: {
    marginBottom: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: 6,
  },
  slotCard: {
    marginBottom: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: 8,
  },
  slotRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 12 },
  slotTime: { minWidth: 140, flexGrow: 1, flexBasis: 140 },
  slotDuration: { minWidth: 220, flexGrow: 2, flexBasis: 220 },
  ruleDay: { fontWeight: '700', color: theme.colors.text, fontSize: 15 },
  ruleSub: { fontSize: 12, fontWeight: '600', color: theme.colors.textMuted, marginTop: 4 },
  ruleTime: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
  ruleTimeText: { fontSize: 16, fontWeight: '800', color: theme.colors.text, minWidth: 64, textAlign: 'center' },
  durationLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.textMuted,
    marginBottom: 6,
  },
  durationRow: { flexDirection: 'row', alignItems: 'center' },
  durationBlock: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  durationValue: { fontSize: 18, fontWeight: '800', color: theme.colors.text, minWidth: 72, textAlign: 'center' },
  error: {
    color: theme.colors.danger,
    backgroundColor: '#FEE2E2',
    padding: 12,
    borderRadius: theme.radius.sm,
    marginBottom: 12,
    fontWeight: '600',
  },
  link: {
    color: theme.colors.primary,
    fontWeight: '600',
    fontSize: 15,
    textDecorationLine: 'underline',
  },
});
