import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

export default function EmployeeHomePage() {
  const role = headers().get('x-user-role');
  if (!role) redirect('/login');
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold">Employee home</h1>
      <p className="mt-2 text-gray-700">Check-in coming in Phase 2.</p>
    </main>
  );
}