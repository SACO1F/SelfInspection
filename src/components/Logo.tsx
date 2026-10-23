export function Logo({ size = 26 }: { size?: number }) {
  const rays = Array.from({ length: 12 }, (_, i) => i * 30)
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" className="brand-mark">
      <g stroke="currentColor" strokeWidth="3.4" strokeLinecap="round">
        {rays.map((angle) => {
          const rad = (angle * Math.PI) / 180
          const inner = 4.5
          const outer = angle % 90 === 0 ? 17 : 14
          return (
            <line
              key={angle}
              x1={20 + Math.cos(rad) * inner}
              y1={20 + Math.sin(rad) * inner}
              x2={20 + Math.cos(rad) * outer}
              y2={20 + Math.sin(rad) * outer}
            />
          )
        })}
      </g>
    </svg>
  )
}
