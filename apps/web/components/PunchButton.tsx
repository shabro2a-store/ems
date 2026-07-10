interface Props {
  isIn: boolean;
  disabled: boolean;
  onPunch: (kind: 'IN' | 'OUT') => void;
}

export default function PunchButton({ isIn, disabled, onPunch }: Props) {
  const kind = isIn ? 'OUT' : 'IN';
  const baseClass = 'w-full min-h-[120px] text-3xl font-bold rounded-2xl';
  const variant = isIn
    ? 'bg-red-600 hover:bg-red-700 text-white'
    : 'bg-green-600 hover:bg-green-700 text-white';
  const label = isIn ? 'CHECK OUT' : 'CHECK IN';
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={() => onPunch(kind)}
      className={`${baseClass} ${variant} disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      {label}
    </button>
  );
}
