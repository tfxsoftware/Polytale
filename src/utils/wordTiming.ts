export interface WordTiming {
  word: string;
  /** Segundos desde o início da fala. */
  start: number;
  end: number;
}

/**
 * Duração de cada palavra, proporcional ao seu tamanho (mesmo peso usado por
 * `estimateSpeechDuration`), somando `totalDuration`. Função pura — mesmas
 * entradas sempre produzem a mesma divisão (seek-safe).
 */
export function wordTimings(text: string, totalDuration: number): WordTiming[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const weights = words.map((w) => Math.max(1, w.length));
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  let t = 0;
  return words.map((word, i) => {
    const start = t;
    t += (weights[i] / totalWeight) * totalDuration;
    return { word, start, end: t };
  });
}
