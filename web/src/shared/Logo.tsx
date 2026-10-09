export function PulseIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M2 12h4l2.5-6 4 12 3-8 1.5 2H22"
        stroke="white"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Brand({ subtitle }: { subtitle: string }) {
  return (
    <div className="brand">
      <div className="logo">
        <PulseIcon />
      </div>
      <div>
        PulseLake
        <small>{subtitle}</small>
      </div>
    </div>
  );
}
