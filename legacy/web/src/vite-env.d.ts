/// <reference types="vite/client" />

declare module "@cellmax/katex-renderer" {
  export const epsilon: number;
  export function isClose(a: number, b: number): boolean;
  export function escapeHtml(unsafe: unknown): string;

  export type KatexSegment = { type: "text" | "math"; content: string };
  export function parseKatexSegments(inputString: unknown): KatexSegment[];

  export function renderMathSegment(mathSegment: string): string;
  export function renderStringToElement(container: HTMLElement, rawString: unknown, options?: Record<string, unknown>): void;
  export function renderStringToHtml(rawString: unknown, options?: Record<string, unknown>): string;

  export function formatTickLabelString(
    labelString: unknown,
    options?: { axis?: "left" | "right" | "top" | "bottom" | null; sciDecimals?: number; trimZeros?: boolean }
  ): string;
  export function formatStringToMathDisplay(originalString: string, options?: { debug?: boolean }): string;
}

