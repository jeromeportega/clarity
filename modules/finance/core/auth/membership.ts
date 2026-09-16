import { and, eq, isNull, ne, or } from 'drizzle-orm';

import type { FinanceDb } from '../../db/client';
import { householdMembers, households, users } from '../../db/schema';

/** What the identity provider tells us about the signed-in person. */
export interface Identity {
  /** The provider's stable subject (a Clerk user id). */
  userId: string;
  email?: string | null;
  displayName?: string | null;
}

export interface Membership {
  householdId: string;
  role: 'owner' | 'member';
  /** True when this call created the household (first sign-in). */
  provisioned: boolean;
}

export interface ResolveMembershipOptions {
  /**
   * Whether a person with no membership may be given a household of their
   * own. The caller decides (an operator allowlist); false means a stranger
   * who signs up gets nothing — no household, no writes.
   */
  provision: boolean;
}

/**
 * The household a first sign-in provisions is named after the person, so two
 * sign-ins racing for the same person converge on ONE row (the second insert
 * is a primary-key no-op) — no transaction, no lock, no orphan household.
 */
export function ownHouseholdId(userId: string): string {
  return `hh_${userId}`;
}

/**
 * The one place a signed-in identity becomes a household.
 *
 *   a known member          → their household (the one they joined first;
 *                             choosing between several is a later feature),
 *                             with the provider's email kept current;
 *   an unknown person, and
 *   provisioning allowed    → a household of their own, created here, owned
 *                             by them — so the first user of a deployment
 *                             needs no seed, no invite, no admin step;
 *   otherwise               → null: signed in, but with no household here.
 *
 * Fails closed whenever the "own" household already exists: provisioning
 * creates a household or joins nothing. A row someone else created under this
 * id is never joined; a household the person was removed from is never
 * re-joined, whether or not anyone else is still in it; an orphaned row with
 * no members at all stays closed too (an operator who wants it re-used adds
 * the membership by hand). The other half of a concurrent first sign-in gets
 * the membership the winning half recorded — and, in the brief window before
 * it is recorded, null for that one request rather than a second household.
 * Every write is insert-or-ignore, so the function is idempotent and safe
 * under concurrent first sign-ins without holding a transaction.
 */
export async function resolveMembership(
  db: FinanceDb,
  identity: Identity,
  opts: ResolveMembershipOptions,
): Promise<Membership | null> {
  const existing = await findMembership(db, identity.userId);
  if (existing) {
    await refreshProfile(db, identity);
    return { ...existing, provisioned: false };
  }
  if (!opts.provision) return null;

  await db
    .insert(users)
    .values({ id: identity.userId, email: identity.email ?? null, displayName: identity.displayName ?? null })
    .onConflictDoNothing();
  const householdId = ownHouseholdId(identity.userId);
  const created = await db
    .insert(households)
    .values({ id: householdId, name: householdNameFor(identity) })
    .onConflictDoNothing()
    .returning({ id: households.id });

  if (created.length === 0) {
    // The row already existed: someone else's, one we were removed from, an
    // orphan, or the other half of a race that has just recorded our
    // membership. Only that last case yields a household — and only through
    // the membership row, never by joining here.
    const recorded = await findMembership(db, identity.userId);
    return recorded ? { ...recorded, provisioned: false } : null;
  }
  await db
    .insert(householdMembers)
    .values({ userId: identity.userId, householdId, role: 'owner' })
    .onConflictDoNothing();

  const membership = await findMembership(db, identity.userId);
  if (!membership) return null;
  return { ...membership, provisioned: created.length > 0 };
}

async function findMembership(db: FinanceDb, userId: string): Promise<Omit<Membership, 'provisioned'> | null> {
  const rows = await db
    .select({ householdId: householdMembers.householdId, role: householdMembers.role })
    .from(householdMembers)
    .where(eq(householdMembers.userId, userId))
    .orderBy(householdMembers.createdAt, householdMembers.householdId)
    .limit(1);
  return rows[0] ?? null;
}

/** The provider is the source of truth for the profile; keep our copy current, cheaply. */
async function refreshProfile(db: FinanceDb, identity: Identity): Promise<void> {
  const email = identity.email ?? null;
  if (email === null) return;
  await db
    .update(users)
    .set({ email, displayName: identity.displayName ?? null })
    .where(and(eq(users.id, identity.userId), or(isNull(users.email), ne(users.email, email))));
}

function householdNameFor(identity: Identity): string {
  const who = identity.displayName?.trim() || identity.email?.split('@')[0]?.trim();
  return who ? `${who}'s household` : 'My household';
}
