import type { Friendship, Profile } from '@/lib/types';

export function friendshipOtherId(f: Pick<Friendship, 'from_user_id' | 'to_user_id'>, userId: string): string {
  return f.from_user_id === userId ? f.to_user_id : f.from_user_id;
}

/** One friendship row per other person (email/user identity). */
export function dedupeFriendshipsByOther<T extends Pick<Friendship, 'from_user_id' | 'to_user_id' | 'status' | 'updated_at' | 'created_at'>>(
  rows: T[],
  userId: string
): T[] {
  const byOther = new Map<string, T>();
  const rank = (s: string) => (s === 'accepted' ? 0 : s === 'pending' ? 1 : 2);

  for (const row of rows) {
    const otherId = friendshipOtherId(row, userId);
    const prev = byOther.get(otherId);
    if (!prev) {
      byOther.set(otherId, row);
      continue;
    }
    const betterStatus = rank(row.status) < rank(prev.status);
    const newer =
      rank(row.status) === rank(prev.status) &&
      new Date(row.updated_at || row.created_at).getTime() >
        new Date(prev.updated_at || prev.created_at).getTime();
    if (betterStatus || newer) byOther.set(otherId, row);
  }
  return Array.from(byOther.values());
}

/** Profiles are unique by email (case-insensitive); fallback to id. */
export function dedupeProfilesByEmail(profiles: Profile[]): Profile[] {
  const byKey = new Map<string, Profile>();
  for (const p of profiles) {
    const key = p.email?.trim().toLowerCase() || p.id;
    if (!byKey.has(key)) byKey.set(key, p);
  }
  return Array.from(byKey.values());
}
