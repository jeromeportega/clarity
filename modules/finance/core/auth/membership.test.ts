/**
 * resolveMembership — a signed-in identity becomes exactly one household.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type FinanceDb } from '../../db/client';
import { householdMembers, households, users } from '../../db/schema';
import { resolveMembership } from './membership';

let db: FinanceDb;
let cleanup: () => void;

describe('resolveMembership', () => {
  beforeEach(() => {
    ({ db, cleanup } = createTestDb());
  });
  afterEach(() => cleanup());

  it('provisions a household on first sign-in and makes the person its owner', async () => {
    const m = await resolveMembership(db, { userId: 'user_1', email: 'sam@example.com', displayName: 'Sam' });

    expect(m.provisioned).toBe(true);
    expect(m.role).toBe('owner');
    const hh = await db.select().from(households).where(eq(households.id, m.householdId));
    expect(hh[0]!.name).toBe("Sam's household");
    const u = await db.select().from(users).where(eq(users.id, 'user_1'));
    expect(u[0]).toMatchObject({ email: 'sam@example.com', displayName: 'Sam' });
    const members = await db.select().from(householdMembers).where(eq(householdMembers.userId, 'user_1'));
    expect(members).toEqual([expect.objectContaining({ householdId: m.householdId, role: 'owner' })]);
  });

  it('returns the same household on every later sign-in, without rewriting the profile', async () => {
    const first = await resolveMembership(db, { userId: 'user_1', email: 'sam@example.com' });
    const second = await resolveMembership(db, { userId: 'user_1', email: 'sam@new.example.com', displayName: 'Samantha' });

    expect(second.householdId).toBe(first.householdId);
    expect(second.provisioned).toBe(false);
    expect(await db.select().from(households)).toHaveLength(1);
    // Profile fields are refreshed only when the member is first written; a
    // known member's row is left alone (the provider is the source of truth).
    const u = await db.select().from(users).where(eq(users.id, 'user_1'));
    expect(u[0]!.email).toBe('sam@example.com');
  });

  it('two people get two households', async () => {
    const a = await resolveMembership(db, { userId: 'user_a', email: 'a@example.com' });
    const b = await resolveMembership(db, { userId: 'user_b', email: 'b@example.com' });
    expect(a.householdId).not.toBe(b.householdId);
    expect(await db.select().from(households)).toHaveLength(2);
  });

  it('a person added to an existing household gets that household, not a new one', async () => {
    await db.insert(households).values({ id: 'hh-shared', name: 'Shared' });
    await db.insert(users).values({ id: 'user_x' });
    await db.insert(householdMembers).values({ userId: 'user_x', householdId: 'hh-shared', role: 'member' });

    const m = await resolveMembership(db, { userId: 'user_x' });
    expect(m).toEqual({ householdId: 'hh-shared', role: 'member', provisioned: false });
    expect(await db.select().from(households)).toHaveLength(1);
  });

  it('names the household from the display name, else the email’s local part, else a default', async () => {
    const byName = await resolveMembership(db, { userId: 'u1', email: 'x@example.com', displayName: 'Ana' });
    const byEmail = await resolveMembership(db, { userId: 'u2', email: 'jordan@example.com' });
    const fallback = await resolveMembership(db, { userId: 'u3' });
    const names = Object.fromEntries(
      (await db.select().from(households)).map((h) => [h.id, h.name]),
    );
    expect(names[byName.householdId]).toBe("Ana's household");
    expect(names[byEmail.householdId]).toBe("jordan's household");
    expect(names[fallback.householdId]).toBe('My household');
  });

  it('two concurrent first sign-ins for the same person end with one household', async () => {
    const results = await Promise.all([
      resolveMembership(db, { userId: 'user_race', email: 'r@example.com' }),
      resolveMembership(db, { userId: 'user_race', email: 'r@example.com' }),
    ]);
    expect(results[0]!.householdId).toBe(results[1]!.householdId);
    expect(await db.select().from(households)).toHaveLength(1);
    expect(await db.select().from(householdMembers)).toHaveLength(1);
  });
});
