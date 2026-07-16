import { describe, it, expect } from 'vitest';
import { Role } from '@prisma/client';

function validateUserCreate(
  username: string,
  password: string,
  role: string,
  branchId: string,
  rate: string,
): string | null {
  if (!username.trim()) return 'Username required';
  if (!password) return 'Password required';
  if (password.length < 4) return 'Password too short';
  if (!['EMPLOYEE', 'DRIVER', 'ADMIN'].includes(role)) return 'Invalid role';
  if ((role === 'EMPLOYEE' || role === 'DRIVER') && !branchId) return 'Branch required for non-admin';
  if (!rate || isNaN(Number(rate)) || Number(rate) < 0) return 'Rate must be positive (USD/hour)';
  return null;
}

describe('<UserCreateModal> validation', () => {
  it('returns null for valid employee input', () => {
    expect(validateUserCreate('john', 'password123', 'EMPLOYEE', 'b1', '2.00')).toBeNull();
  });

  it('returns null for valid admin input (no branch)', () => {
    expect(validateUserCreate('admin1', 'password123', 'ADMIN', '', '2.00')).toBeNull();
  });

  it('returns error for empty username', () => {
    expect(validateUserCreate('', 'password123', 'EMPLOYEE', 'b1', '2.00')).toBe('Username required');
  });

  it('returns error for whitespace-only username', () => {
    expect(validateUserCreate('   ', 'password123', 'EMPLOYEE', 'b1', '2.00')).toBe('Username required');
  });

  it('returns error for missing password', () => {
    expect(validateUserCreate('john', '', 'EMPLOYEE', 'b1', '2.00')).toBe('Password required');
  });

  it('returns error for short password', () => {
    expect(validateUserCreate('john', 'abc', 'EMPLOYEE', 'b1', '2.00')).toBe('Password too short');
  });

  it('returns error for invalid role', () => {
    expect(validateUserCreate('john', 'password123', 'SUPERUSER', 'b1', '2.00')).toBe('Invalid role');
  });

  it('returns error for employee without branch', () => {
    expect(validateUserCreate('john', 'password123', 'EMPLOYEE', '', '2.00')).toBe('Branch required for non-admin');
  });

  it('returns error for driver without branch', () => {
    expect(validateUserCreate('john', 'password123', 'DRIVER', '', '2.00')).toBe('Branch required for non-admin');
  });

  it('returns null for admin without branch', () => {
    expect(validateUserCreate('admin1', 'password123', 'ADMIN', '', '2.00')).toBeNull();
  });

  it('returns error for missing rate', () => {
    expect(validateUserCreate('john', 'password123', 'EMPLOYEE', 'b1', '')).toBe('Rate must be positive (USD/hour)');
  });

  it('returns error for negative rate', () => {
    expect(validateUserCreate('john', 'password123', 'EMPLOYEE', 'b1', '-1')).toBe('Rate must be positive (USD/hour)');
  });

  it('returns error for non-numeric rate', () => {
    expect(validateUserCreate('john', 'password123', 'EMPLOYEE', 'b1', 'abc')).toBe('Rate must be positive (USD/hour)');
  });
});