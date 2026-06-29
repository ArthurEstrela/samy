import { hueFromId } from '../lib/hue';

const BAR_COUNT = 28;

export function Voiceprint({ seed, alive }: { seed: string; alive: boolean }): JSX.Element {
  const hue = hueFromId(seed);
  // alturas determinísticas a partir do seed
  const bars = Array.from({ length: BAR_COUNT }, (_, i) => {
    const n = (hueFromId(`${seed}:${i}`) % 70) + 20; // 20..89
    return n;
  });
  return (
    <div
      className="flex items-end gap-[2px] h-8"
      role="img"
      aria-label={alive ? 'voz ao vivo' : 'voz offline'}
    >
      {bars.map((h, i) => (
        <span
          key={i}
          className={alive ? 'voiceprint-bar voiceprint-bar--alive' : 'voiceprint-bar'}
          style={{
            height: `${h}%`,
            width: 3,
            background: alive ? `hsl(${hue} 70% 60%)` : 'var(--color-mist)',
            opacity: alive ? 1 : 0.5,
            animationDelay: `${i * 60}ms`,
          }}
        />
      ))}
    </div>
  );
}
