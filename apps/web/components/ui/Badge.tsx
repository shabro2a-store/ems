import React from 'react';

type Tone = 'neutral' | 'primary' | 'success' | 'danger' | 'warning';

const tones: Record<Tone, string> = {
  neutral: 'bg-surface-muted text-muted border-border',
  primary: 'bg-primary-subtle text-primary border-primary/20',
  success: 'bg-success-subtle text-success border-success/20',
  danger: 'bg-danger-subtle text-danger border-danger/20',
  warning: 'bg-warning-subtle text-warning border-warning/20',
};

export function Badge({
  tone = 'neutral',
  className = '',
  children,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

// A small colored dot for status, paired with a label so meaning isn't color-only.
export function StatusDot({ tone = 'neutral' }: { tone?: Tone }) {
  const color: Record<Tone, string> = {
    neutral: 'bg-muted',
    primary: 'bg-primary',
    success: 'bg-success',
    danger: 'bg-danger',
    warning: 'bg-warning',
  };
  return <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${color[tone]}`} />;
}
