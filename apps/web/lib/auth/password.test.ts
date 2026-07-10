import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './password';
import { BCRYPT_ROUNDS } from './constants';

describe('password', () => {
  it('hashes with the spec-mandated bcrypt rounds', async () => {
    const hash = await hashPassword('change-me');
    expect(hash).toMatch(new RegExp(`^\\$2[aby]\\$${String(BCRYPT_ROUNDS).padStart(2, '0')}\\$`));
  });

  it('verifies a correct password', async () => {
    const hash = await hashPassword('change-me');
    await expect(verifyPassword('change-me', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('change-me');
    await expect(verifyPassword('wrong', hash)).resolves.toBe(false);
  });

  it('produces different hashes for the same input (salt randomness)', async () => {
    const a = await hashPassword('change-me');
    const b = await hashPassword('change-me');
    expect(a).not.toBe(b);
    await expect(verifyPassword('change-me', a)).resolves.toBe(true);
    await expect(verifyPassword('change-me', b)).resolves.toBe(true);
  });
});