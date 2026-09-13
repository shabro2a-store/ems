import React from 'react';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    // Title left, controls right, on one line; on a phone the controls drop
    // under the title and wrap as they need to.
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

type Tone = 'neutral' | 'primary' | 'success' | 'danger' | 'warning';

const tileTone: Record<Tone, string> = {
  neutral: 'text-content',
  primary: 'text-primary',
  success: 'text-success',
  danger: 'text-danger',
  warning: 'text-warning',
};

export function StatTile({
  label,
  value,
  tone = 'neutral',
  hint,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: Tone;
  hint?: React.ReactNode;
}) {
  // h-full: tiles in one grid row stand the same height whatever their hint
  // says, and the hint sits at the bottom of every tile rather than wherever
  // the figure above it happened to end.
  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-surface px-3.5 py-3 shadow-card">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold leading-none tabular ${tileTone[tone]}`}>{value}</div>
      {hint && <div className="mt-auto pt-1.5 text-xs leading-snug text-muted">{hint}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  icon,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-border bg-surface px-6 py-10 text-center">
      {icon && <div className="mb-3 text-muted">{icon}</div>}
      <p className="font-medium text-content">{title}</p>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block h-5 w-5 animate-spin rounded-full border-2 border-muted border-r-transparent ${className}`}
    />
  );
}

export function Alert({
  tone = 'danger',
  children,
}: {
  tone?: 'danger' | 'success' | 'warning' | 'primary';
  children: React.ReactNode;
}) {
  const map = {
    danger: 'bg-danger-subtle text-danger border-danger/20',
    success: 'bg-success-subtle text-success border-success/20',
    warning: 'bg-warning-subtle text-warning border-warning/20',
    primary: 'bg-primary-subtle text-primary border-primary/20',
  } as const;
  return (
    <div role="status" className={`rounded-lg border px-3 py-2 text-sm ${map[tone]}`}>
      {children}
    </div>
  );
}
