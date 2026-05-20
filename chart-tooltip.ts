export const TOOLTIP_MAX_ROWS_PER_COLUMN = 20;
export const DEFAULT_TOOLTIP_OPACITY = 0.9;

const TOOLTIP_VIEWPORT_GUTTER = 12;
const TOOLTIP_CURSOR_BASELINE_OFFSET = 40;
const TOOLTIP_MIN_OPACITY = 0.2;
const TOOLTIP_MAX_OPACITY = 1;

type TooltipSize = {
  contentSize?: unknown;
  viewSize?: unknown;
};

export function chunkTooltipRows(
  rows: string[],
  rowsPerColumn = TOOLTIP_MAX_ROWS_PER_COLUMN,
): string[][] {
  const safeRowsPerColumn = Number.isFinite(rowsPerColumn)
    ? Math.max(1, Math.floor(rowsPerColumn))
    : TOOLTIP_MAX_ROWS_PER_COLUMN;
  const columns: string[][] = [];

  for (let index = 0; index < rows.length; index += safeRowsPerColumn) {
    columns.push(rows.slice(index, index + safeRowsPerColumn));
  }

  return columns;
}

export function normalizeTooltipOpacity(value: number | null | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_TOOLTIP_OPACITY;
  }

  const normalized = Math.round(Number(value) * 100) / 100;
  return Math.min(TOOLTIP_MAX_OPACITY, Math.max(TOOLTIP_MIN_OPACITY, normalized));
}

export function getTooltipSurfaceStyle(isDarkMode: boolean, tooltipOpacity: number) {
  const safeOpacity = normalizeTooltipOpacity(tooltipOpacity);
  const borderAlpha = isDarkMode
    ? Math.min(0.6, Math.max(0.22, safeOpacity * 0.7))
    : Math.min(0.42, Math.max(0.18, safeOpacity * 0.45));

  return {
    backgroundColor: isDarkMode
      ? `rgba(2, 6, 23, ${safeOpacity})`
      : `rgba(255, 255, 255, ${safeOpacity})`,
    borderColor: `rgba(148, 163, 184, ${borderAlpha})`,
    textColor: isDarkMode ? "rgb(248 250 252)" : "rgb(15 23 42)",
  };
}

export function getCursorAnchoredTooltipPosition(
  point: number[],
  size: TooltipSize,
): [number, number] {
  const [rawX = 0, rawY = 0] = Array.isArray(point) ? point : [0, 0];
  const contentSize = Array.isArray(size?.contentSize) ? size.contentSize : [0, 0];
  const viewSize = Array.isArray(size?.viewSize) ? size.viewSize : [0, 0];

  const x = Number(rawX);
  const y = Number(rawY);
  const tooltipWidth = Number(contentSize[0] ?? 0);
  const tooltipHeight = Number(contentSize[1] ?? 0);
  const viewWidth = Number(viewSize[0] ?? 0);
  const viewHeight = Number(viewSize[1] ?? 0);
  const hasViewSize =
    Number.isFinite(viewWidth) && Number.isFinite(viewHeight) && viewWidth > 0 && viewHeight > 0;

  const preferredX = Number.isFinite(x) ? x : 0;
  const preferredY = (Number.isFinite(y) ? y : 0) - tooltipHeight + TOOLTIP_CURSOR_BASELINE_OFFSET;

  if (!hasViewSize) {
    return [preferredX, preferredY];
  }

  const maxX = Math.max(
    TOOLTIP_VIEWPORT_GUTTER,
    viewWidth - tooltipWidth - TOOLTIP_VIEWPORT_GUTTER,
  );
  const maxY = Math.max(-tooltipHeight, viewHeight - tooltipHeight - TOOLTIP_VIEWPORT_GUTTER);

  return [
    Math.min(Math.max(TOOLTIP_VIEWPORT_GUTTER, preferredX), maxX),
    Math.min(preferredY, maxY),
  ];
}
