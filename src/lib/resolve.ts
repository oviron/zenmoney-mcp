import type { Account, Tag } from "../api.js";
import type { ZenState } from "../state.js";

/**
 * Resolve a name or id to exactly one entity. An id or an exact title (case
 * insensitive) wins over a substring match, and an ambiguous name is reported
 * instead of silently resolving to whichever entity happens to come first:
 * with two accounts called "Mortgage", the first-hit lookup could put money
 * on either. `preferred` breaks a tie when exactly one candidate passes it.
 */
export function resolveStrict<T extends { id: string; title: string }>(
  items: T[],
  nameOrId: string,
  preferred?: (item: T) => boolean
): { match: T } | { candidates: T[] } {
  const byId = items.find((i) => i.id === nameOrId);
  if (byId) return { match: byId };

  const lower = nameOrId.trim().toLowerCase();
  if (lower === "") return { candidates: [] };

  const pick = (matches: T[]): { match: T } | { candidates: T[] } => {
    if (matches.length === 1) return { match: matches[0] };
    const liked = preferred ? matches.filter(preferred) : [];
    if (liked.length === 1) return { match: liked[0] };
    return { candidates: matches };
  };

  const exact = items.filter((i) => i.title.toLowerCase() === lower);
  if (exact.length > 0) return pick(exact);

  const partial = items.filter((i) => i.title.toLowerCase().includes(lower));
  if (partial.length > 0) return pick(partial);

  return { candidates: [] };
}

export function resolveTagStrict(
  state: ZenState,
  nameOrId: string
): { tag: Tag } | { error: string } {
  const r = resolveStrict(state.tags, nameOrId);
  if ("match" in r) return { tag: r.match };
  if (r.candidates.length > 0) {
    return { error: ambiguous("Category", nameOrId, r.candidates, "category id") };
  }
  return {
    error: `Category "${nameOrId}" not found. Use list_categories to see available categories.`,
  };
}

/** Like resolveTagStrict; an archived account loses a tie to an active one. */
export function resolveAccountStrict(
  state: ZenState,
  nameOrId: string,
  label = "Account"
): { account: Account } | { error: string } {
  const r = resolveStrict(state.accounts, nameOrId, (a) => !a.archive);
  if ("match" in r) return { account: r.match };
  if (r.candidates.length > 0) {
    return { error: ambiguous(label, nameOrId, r.candidates, "account id") };
  }
  return {
    error: `${label} "${nameOrId}" not found. Use list_accounts to see available accounts.`,
  };
}

export function ambiguous(
  label: string,
  input: string,
  matches: { id: string; title: string }[],
  idName: string
): string {
  const list = matches.map((m) => `${m.title} (${m.id})`).join(", ");
  return `${label} "${input}" is ambiguous — it matches: ${list}. Use the exact title or the ${idName}.`;
}
