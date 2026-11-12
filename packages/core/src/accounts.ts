import { accounts, type Db } from '@sr/db';
import { eq } from 'drizzle-orm';
import { AppError } from './errors.ts';

/** Creates the account if it doesn't exist yet and keeps the email current. */
export async function ensureAccount(db: Db, user: { id: string; email: string }): Promise<void> {
  await db
    .insert(accounts)
    .values({ id: user.id, email: user.email })
    .onConflictDoUpdate({ target: accounts.id, set: { email: user.email } });
}

export async function getAccount(db: Db, accountId: string) {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) throw new AppError('not_found', 'Account not found');
  return account;
}
