import { eq } from 'drizzle-orm';

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

/**
 * The household a first sign-in provisions is named after the person, so two
 * sign-ins racing for the same person converge on ONE row (the second insert
 * is a primary-key no-op) — no transaction, no lock, no orphan household.
 */
export function ownHouseholdId(userId: string): string {
  return `hh_${userId}`;
}

/**
 * The one place a signed-in identity becomes a household. A known member gets
 * their household back; a person signing in for the first time gets a
 * household of their own, created here, and becomes its owner — so the first
 * user of a deployment needs no seed, no invite and no admin step. A person
 * in several households gets the one they joined first; choosing between
 * them is a later feature.
 *
 * Every write is insert-or-ignore on a key derived from the identity, so the
 * function is idempotent and safe under concurrent first sign-ins without
 * holding a database transaction (which, on a shared libSQL handle, a racing
 * caller could otherwise poison).
 */
export async function resolveMembership(db: FinanceDb, identity: Identity): Promise<Membership> {
  const existing = await findMembership(db, identity.userId);
  if (existing) return { ...existing, provisioned: false };

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
  await db
    .insert(householdMembers)
    .values({ userId: identity.userId, householdId, role: 'owner' })
    .onConflictDoNothing();

  const membership = await findMembership(db, identity.userId);
  if (!membership) throw new Error(`membership for ${identity.userId} could not be established`);
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

function householdNameFor(identity: Identity): string {
  const who = identity.displayName?.trim() || identity.email?.split('@')[0]?.trim();
  return who ? `${who}'s household` : 'My household';
}
