import { hueFromId } from '../lib/hue';

export function Orb({ seed, size = 56 }: { seed: string; size?: number }): JSX.Element {
  const hue = hueFromId(seed);
  const style = {
    width: size,
    height: size,
    background: `radial-gradient(circle at 30% 30%, hsl(${hue} 70% 62%), hsl(${(hue + 40) % 360} 55% 28%))`,
  };
  return <div aria-hidden className="rounded-full shrink-0" style={style} />;
}
