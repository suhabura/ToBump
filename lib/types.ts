export type Privacy = 'invite' | 'friends' | 'group' | 'friends_of_friends';
export type FriendshipStatus = 'pending' | 'accepted' | 'rejected';

export type FundingMode = 'per_event' | 'monthly' | 'annual';
export type ExpenseType = 'per_event' | 'monthly' | 'annual' | 'manual';
export type SplitMode = 'equal_all' | 'equal_attendees' | 'selected';
export type ObligationStatus = 'unpaid' | 'partial' | 'paid' | 'waived';

export type SeriesFinanceSettings = {
  series_id: string;
  funding_mode: FundingMode;
  amount: number;
  currency: string;
  updated_by: string | null;
  updated_at: string;
  created_at: string;
};

export type ActivityExpense = {
  id: string;
  series_id: string;
  activity_id: string | null;
  expense_type: ExpenseType;
  title: string;
  amount: number;
  period_key: string | null;
  split_mode: SplitMode;
  paid_by: string | null;
  created_by: string;
  created_at: string;
};

export type ActivitySettlement = {
  id: string;
  series_id: string;
  from_user_id: string;
  to_user_id: string;
  amount: number;
  note: string | null;
  created_by: string;
  created_at: string;
};

export type ActivityObligation = {
  id: string;
  expense_id: string;
  series_id: string;
  user_id: string;
  amount_due: number;
  amount_paid: number;
  status: ObligationStatus;
  due_date: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type ActivityPayment = {
  id: string;
  obligation_id: string;
  amount: number;
  note: string | null;
  recorded_by: string;
  created_at: string;
};
export type ActivityStatus = 'active' | 'cancelled' | 'completed';

export type FriendGroup = {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
};

export type FriendGroupMember = {
  id: string;
  group_id: string;
  user_id: string;
  created_at: string;
};

export type Profile = {
  id: string;
  email: string | null;
  first_name: string;
  last_name: string;
  phone: string | null;
  avatar_url: string | null;
  gender: string | null;
  dob: string | null;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  created_at: string;
  updated_at: string;
};

export type Category = {
  id: string;
  name: string;
  icon: string | null;
  parent_id: string | null;
  created_at: string;
  parent?: Pick<Category, 'id' | 'name' | 'icon'> | null;
};

export type EnterpriseProviderKind = 'official' | 'tobump_booking';

export type Enterprise = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  email: string | null;
  latitude: number | null;
  longitude: number | null;
  category_id: string | null;
  price: number | null;
  created_by: string | null;
  is_approved: boolean;
  provider_kind: EnterpriseProviderKind;
  created_at: string;
};

export type Activity = {
  id: string;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string | null;
  price: number | null;
  max_participants: number | null;
  privacy: Privacy;
  category_id: string | null;
  enterprise_id: string | null;
  venue_text: string | null;
  group_id: string | null;
  created_by: string;
  chat_enabled: boolean;
  status: ActivityStatus;
  is_recurring: boolean;
  recurrence_weekdays: number[];
  recurrence_rules: { weekday: number; hour: number; minute: number; duration_minutes: number }[];
  duration_minutes: number | null;
  /** Last day a new occurrence may start (YYYY-MM-DD) */
  recurrence_until: string | null;
  series_id: string | null;
  previous_activity_id: string | null;
  /** Locked from first recurring event — used when opening the next occurrence */
  series_privacy: Privacy | null;
  series_group_id: string | null;
  series_invite_user_ids: string[];
  created_at: string;
  updated_at: string;
};

export type ActivitySlot = {
  id: string;
  activity_id: string;
  label: string | null;
  starts_at: string;
  ends_at: string | null;
  created_at: string;
};

export type ActivityJoin = {
  id: string;
  activity_id: string;
  user_id: string;
  joined_at: string;
};

export type ActivityInvite = {
  id: string;
  activity_id: string;
  user_id: string;
  invited_by: string;
  created_at: string;
};

export type ActivityEditor = {
  id: string;
  activity_id: string;
  user_id: string;
  granted_by: string;
  created_at: string;
};

export type Friendship = {
  id: string;
  from_user_id: string;
  to_user_id: string;
  status: FriendshipStatus;
  created_at: string;
  updated_at: string;
};

export type ChatMessage = {
  id: string;
  activity_id: string;
  user_id: string;
  message: string;
  created_at: string;
};

export type Notification = {
  id: string;
  user_id: string;
  type: string;
  message: string;
  data: Record<string, unknown> | null;
  is_read: boolean;
  created_at: string;
};

export type UserSettings = {
  user_id: string;
  notify_activity_join: boolean;
  notify_message: boolean;
  notify_friend_request: boolean;
  notify_invite: boolean;
  push_token: string | null;
  /** UI language: en (default) | sl | … — optional until migration */
  locale?: string;
  updated_at: string;
};

export type ActivityWithRelations = Activity & {
  profiles?: Pick<Profile, 'id' | 'first_name' | 'last_name' | 'avatar_url'> | null;
  categories?: (Pick<Category, 'id' | 'name' | 'icon' | 'parent_id'> & {
    parent?: Pick<Category, 'id' | 'name'> | null;
  }) | null;
  enterprises?: Pick<Enterprise, 'id' | 'name' | 'address' | 'provider_kind' | 'latitude' | 'longitude'> | null;
  activity_joins?: { count: number }[] | ActivityJoin[];
  join_count?: number;
  is_joined?: boolean;
  is_invited?: boolean;
  is_from_friend?: boolean;
  is_commercial?: boolean;
  distance_m?: number | null;
  sort_group?: number;
};

export type Database = {
  public: {
    Tables: {
      profiles: { Row: Profile; Insert: Partial<Profile> & { id: string }; Update: Partial<Profile> };
      categories: { Row: Category; Insert: Partial<Category>; Update: Partial<Category> };
      enterprises: { Row: Enterprise; Insert: Partial<Enterprise>; Update: Partial<Enterprise> };
      activities: { Row: Activity; Insert: Partial<Activity> & { title: string; starts_at: string; created_by: string }; Update: Partial<Activity> };
      activity_slots: { Row: ActivitySlot; Insert: Partial<ActivitySlot> & { activity_id: string; starts_at: string }; Update: Partial<ActivitySlot> };
      activity_joins: { Row: ActivityJoin; Insert: Partial<ActivityJoin> & { activity_id: string; user_id: string }; Update: Partial<ActivityJoin> };
      activity_invites: { Row: ActivityInvite; Insert: Partial<ActivityInvite> & { activity_id: string; user_id: string; invited_by: string }; Update: Partial<ActivityInvite> };
      activity_editors: {
        Row: ActivityEditor;
        Insert: Partial<ActivityEditor> & { activity_id: string; user_id: string; granted_by: string };
        Update: Partial<ActivityEditor>;
      };
      friendships: { Row: Friendship; Insert: Partial<Friendship> & { from_user_id: string; to_user_id: string }; Update: Partial<Friendship> };
      chat_messages: { Row: ChatMessage; Insert: Partial<ChatMessage> & { activity_id: string; user_id: string; message: string }; Update: Partial<ChatMessage> };
      notifications: { Row: Notification; Insert: Partial<Notification> & { user_id: string; type: string; message: string }; Update: Partial<Notification> };
      user_settings: { Row: UserSettings; Insert: Partial<UserSettings> & { user_id: string }; Update: Partial<UserSettings> };
      activity_reports: {
        Row: { id: string; activity_id: string; reported_by: string; reason: string; created_at: string };
        Insert: { activity_id: string; reported_by: string; reason: string };
        Update: Partial<{ reason: string }>;
      };
    };
  };
};

export function displayName(p?: Pick<Profile, 'first_name' | 'last_name'> | null) {
  if (!p) return 'User';
  const name = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
  return name || 'User';
}

import { categoryDisplayName } from '@/i18n/runtime';

/** Display "Sport · Football" in the active UI language */
export function categoryLabel(
  c?: Pick<Category, 'name'> & { parent?: Pick<Category, 'name'> | null } | null
): string | null {
  if (!c?.name) return null;
  const sub = categoryDisplayName(c.name);
  if (c.parent?.name) return `${categoryDisplayName(c.parent.name)} · ${sub}`;
  return sub;
}

/** Prizorišče / lokacija za izpis dogodka */
export function activityLocationLabel(a: {
  venue_text?: string | null;
  enterprises?: Pick<Enterprise, 'name' | 'address'> | null;
}): string | null {
  if (a.enterprises?.name) {
    return a.enterprises.address?.trim()
      ? `${a.enterprises.name} · ${a.enterprises.address.trim()}`
      : a.enterprises.name;
  }
  const text = a.venue_text?.trim();
  return text || null;
}
