// Hue determinístico (0..359) a partir do id — orb/voiceprint únicos e estáveis por modelo.
export function hueFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) % 360;
  }
  return h;
}
