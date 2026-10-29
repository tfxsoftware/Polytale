import type { AspectRatio } from '../timeline/types';

export interface FrameSize {
  width: number;
  height: number;
}

/** Resolução do vídeo exportado para cada formato (1080p). */
const EXPORT_SIZES: Record<AspectRatio, FrameSize> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
};

/** Largura / altura do formato. */
export function aspectValue(aspect: AspectRatio): number {
  const { width, height } = EXPORT_SIZES[aspect];
  return width / height;
}

export function exportSize(aspect: AspectRatio): FrameSize {
  return { ...EXPORT_SIZES[aspect] };
}
