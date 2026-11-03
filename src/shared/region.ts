import type { CropRect } from './image';
import type { Reply, TranslationResult } from './types';

export interface Viewport { width: number; height: number; x: number; y: number; scale: number }
export interface RegionStyle { background: string; color: string; solid: boolean }
export type RegionCommand =
  | { type: 'REGION_CAPTURE'; token: string; rect: CropRect; viewport: Viewport }
  | { type: 'REGION_CANCEL' | 'REGION_SETTINGS'; token: string };
export type RegionEvent =
  | { type: 'REGION_START'; token: string; problem?: string }
  | { type: 'REGION_LOADING' | 'REGION_DISPOSE'; token: string };
export type RegionReply = Reply<TranslationResult & { style: RegionStyle }>;

export function validRegion(rect: CropRect, viewport: Viewport): boolean {
  if (!rect || !viewport || ![rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height, viewport.x, viewport.y, viewport.scale].every(Number.isFinite)) return false;
  return viewport.width > 0 && viewport.width <= 16000 && viewport.height > 0 && viewport.height <= 16000 && viewport.scale === 1 &&
    rect.x >= 0 && rect.y >= 0 && rect.width >= 8 && rect.height >= 8 && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height;
}

export function sameViewport(a: Viewport, b: Viewport): boolean {
  return Boolean(a && b) && (['width', 'height', 'x', 'y', 'scale'] as const).every(key => a[key] === b[key]);
}
