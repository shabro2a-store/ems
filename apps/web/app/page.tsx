import { redirect } from 'next/navigation';
import { identity } from '@/lib/auth/identity';

export const dynamic = 'force-dynamic';

const HOME = { ADMIN: '/admin', DRIVER: '/driver', CALLER: '/caller', EMPLOYEE: '/employee' } as const;

// The installed app opens here (the manifest's start_url). It used to send
// everybody to the login form, so a person signed in for a week was asked to
// sign in every time they tapped the icon.
export default async function HomePage() {
  const me = await identity();
  redirect(me ? HOME[me.role] : '/login');
}
