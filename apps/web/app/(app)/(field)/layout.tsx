import FieldShell from '@/components/field/FieldShell';

// One layout for every page a field worker can open - the driver's Trips and
// the Advances, Leave and Pay tabs alike - so moving between them keeps the
// same shell mounted. The driver's siren lives in it: while each section had
// its own layout, leaving Trips unmounted the alarm and its keep-alive, and a
// driver checking their pay could not be rung. URLs are unchanged; a (group)
// is not part of the path.
export default function FieldLayout({ children }: { children: React.ReactNode }) {
  return <FieldShell>{children}</FieldShell>;
}
