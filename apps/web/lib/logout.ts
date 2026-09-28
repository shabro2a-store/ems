'use client';

import { apiSend } from './api';

let leaving = false;

/**
 * Sign out everywhere and go to the login form. One copy for the admin bar, the
 * field shell and the caller board (there were three), and once per page: a
 * second tap while the first is on its way does nothing.
 */
export async function logout(): Promise<void> {
  if (leaving) return;
  leaving = true;
  await apiSend('/api/auth/logout');
  window.location.href = '/login';
}
