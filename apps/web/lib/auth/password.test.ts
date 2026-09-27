import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './password';
import { BCRYPT_ROUNDS } from './constants';

describe('password', () => {
  it('hashes with the spec-mandated bcrypt rounds', async () => {
    const hash = await hashPassword('test-pass-1');
    expect(hash).toMatch(new RegExp(`^\\$2[aby]\\$${String(BCRYPT_ROUNDS).padStart(2, '0')}\\$`));
  });

  it('verifies a correct password', async () => {
    const hash = await hashPassword('test-pass-1');
    await expect(verifyPassword('test-pass-1', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('test-pass-1');
    await expect(verifyPassword('wrong', hash)).resolves.toBe(false);
  });

  it('produces different hashes for the same input (salt randomness)', async () => {
    const a = await hashPassword('test-pass-1');
    const b = await hashPassword('test-pass-1');
    expect(a).not.toBe(b);
    await expect(verifyPassword('test-pass-1', a)).resolves.toBe(true);
    await expect(verifyPassword('test-pass-1', b)).resolves.toBe(true);
  });
});