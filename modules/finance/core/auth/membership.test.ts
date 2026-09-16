/**
 * resolveMembership — a signed-in identity becomes exactly one household.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type FinanceDb } from '../../db/client';
import { householdMembers, households, users } from '../../db/schema';
import { resolveMembership } from './membership';

const PROVISION = { provision: true };
const NO_PROVISION = { provision: false };

let db: FinanceDb;
let cleanup: () => void;

describe('resolveMembership', () => {
  beforeEach(() => {
    ({ db, cleanup } = createTestDb());
  });
  afterEach(() => cleanup());

  it('provisions a household on first sign-in and makes the person its owner', async () => {
    const m = (await resolveMembership(db, { userId: 'user_1', email: 'sam@example.com', displayName: 'Sam' }, PROVISION))!;

    expect(m.provisioned).toBe(true);
    expect(m.role).toBe('owner');
    const hh = await db.select().from(households).where(eq(households.id, m.householdId));
    expect(hh[0]!.name).toBe("Sam's household");
    const u = await db.select().from(users).where(eq(users.id, 'user_1'));
    expect(u[0]).toMatchObject({ email: 'sam@example.com', displayName: 'Sam' });
    const members = await db.select().from(householdMembers).where(eq(householdMembers.userId, 'user_1'));
    expect(members).toEqual([expect.objectContaining({ householdId: m.householdId, role: 'owner' })]);
  });

  it('returns the same household on every later sign-in, keeping the profile current', async () => {
    const first = (await resolveMembership(db, { userId: 'user_1', email: 'sam@example.com' }, PROVISION))!;
    const second = (await resolveMembership(db, { userId: 'user_1', email: 'sam@new.example.com', displayName: 'Samantha' }, PROVISION))!;

    expect(second.householdId).toBe(first.householdId);
    expect(second.provisioned).toBe(false);
    expect(await db.select().from(households)).toHaveLength(1);
    // The provider is the source of truth for the profile: a changed email
    // (or name) is written through on the next sign-in.
    const u = await db.select().from(users).where(eq(users.id, 'user_1'));
    expect(u[0]).toMatchObject({ email: 'sam@new.example.com', displayName: 'Samantha' });
  });

  it('a stranger is not provisioned unless the caller allows it — signed in, but no household', async () => {
    expect(await resolveMembership(db, { userId: 'user_stranger', email: 's@example.com' }, NO_PROVISION)).toBeNull();
    expect(await db.select().from(households)).toHaveLength(0);
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it('never joins an existing household under its own id that someone else holds', async () => {
    await db.insert(households).values({ id: 'hh_user_squatter', name: 'Theirs' });
    await db.insert(users).values({ id: 'other' });
    await db.insert(householdMembers).values({ userId: 'other', householdId: 'hh_user_squatter', role: 'owner' });

    expect(await resolveMembership(db, { userId: 'user_squatter' }, PROVISION)).toBeNull();
    const members = await db.select().from(householdMembers).where(eq(householdMembers.householdId, 'hh_user_squatter'));
    expect(members.map((m) => m.userId)).toEqual(['other']);
  });

  it('a person removed from their own household does not re-join it on the next sign-in', async () => {
    const m = (await resolveMembership(db, { userId: 'user_gone', email: 'g@example.com' }, PROVISION))!;
    await db.delete(householdMembers).where(eq(householdMembers.userId, 'user_gone'));
    await db.insert(users).values({ id: 'keeper' });
    await db.insert(householdMembers).values({ userId: 'keeper', householdId: m.householdId, role: 'owner' });

    expect(await resolveMembership(db, { userId: 'user_gone', email: 'g@example.com' }, PROVISION)).toBeNull();
  });

  it('a removed SOLE member does not re-join the now-empty household either', async () => {
    const m = (await resolveMembership(db, { userId: 'user_solo', email: 's@example.com' }, PROVISION))!;
    await db.delete(householdMembers).where(eq(householdMembers.userId, 'user_solo'));

    expect(await resolveMembership(db, { userId: 'user_solo', email: 's@example.com' }, PROVISION)).toBeNull();
    expect(await db.select().from(householdMembers).where(eq(householdMembers.householdId, m.householdId))).toHaveLength(0);
    expect(await db.select().from(households)).toHaveLength(1);
  });

  it('an orphaned household under the person’s own id (no members, no user row) is not joined', async () => {
    await db.insert(households).values({ id: 'hh_user_orphan', name: 'Left behind' });

    expect(await resolveMembership(db, { userId: 'user_orphan', email: 'o@example.com' }, PROVISION)).toBeNull();
    expect(await db.select().from(householdMembers)).toHaveLength(0);
  });

  it('a user row that started without an email picks one up on the next sign-in', async () => {
    await resolveMembership(db, { userId: 'user_noemail' }, PROVISION);
    expect((await db.select().from(users).where(eq(users.id, 'user_noemail')))[0]!.email).toBeNull();

    await resolveMembership(db, { userId: 'user_noemail', email: 'late@example.com', displayName: 'Late' }, NO_PROVISION);
    expect((await db.select().from(users).where(eq(users.id, 'user_noemail')))[0]).toMatchObject({ email: 'late@example.com', displayName: 'Late' });
  });

  it('two people get two households', async () => {
    const a = (await resolveMembership(db, { userId: 'user_a', email: 'a@example.com' }, PROVISION))!;
    const b = (await resolveMembership(db, { userId: 'user_b', email: 'b@example.com' }, PROVISION))!;
    expect(a.householdId).not.toBe(b.householdId);
    expect(await db.select().from(households)).toHaveLength(2);
  });

  it('a person added to an existing household gets that household, not a new one', async () => {
    await db.insert(households).values({ id: 'hh-shared', name: 'Shared' });
    await db.insert(users).values({ id: 'user_x' });
    await db.insert(householdMembers).values({ userId: 'user_x', householdId: 'hh-shared', role: 'member' });

    const m = await resolveMembership(db, { userId: 'user_x' }, PROVISION);
    expect(m).toEqual({ householdId: 'hh-shared', role: 'member', provisioned: false });
    expect(await db.select().from(households)).toHaveLength(1);
  });

  it('names the household from the display name, else the email’s local part, else a default', async () => {
    const byName = (await resolveMembership(db, { userId: 'u1', email: 'x@example.com', displayName: 'Ana' }, PROVISION))!;
    const byEmail = (await resolveMembership(db, { userId: 'u2', email: 'jordan@example.com' }, PROVISION))!;
    const fallback = (await resolveMembership(db, { userId: 'u3' }, PROVISION))!;
    const names = Object.fromEntries(
      (await db.select().from(households)).map((h) => [h.id, h.name]),
    );
    expect(names[byName.householdId]).toBe("Ana's household");
    expect(names[byEmail.householdId]).toBe("jordan's household");
    expect(names[fallback.householdId]).toBe('My household');
  });

  it('two concurrent first sign-ins for the same person end with one household', async () => {
    const results = await Promise.all([
      resolveMembership(db, { userId: 'user_race', email: 'r@example.com' }, PROVISION),
      resolveMembership(db, { userId: 'user_race', email: 'r@example.com' }, PROVISION),
    ]);
    expect(results[0]!!.householdId).toBe(results[1]!!.householdId);
    expect(await db.select().from(households)).toHaveLength(1);
    expect(await db.select().from(householdMembers)).toHaveLength(1);
  });
});
