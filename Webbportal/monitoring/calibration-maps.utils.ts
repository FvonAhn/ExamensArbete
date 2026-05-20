import type { Bin, Map, MapDataPoint, Project } from "../../utils/types";
import type { TelemetryParameterMeta } from "$lib/monitoring/telemetry.domain";
import { formatLabel } from "$lib/monitoring/formatters";

export type ProjectOption = Project & {
  binId: number;
  binName: string;
  active?: boolean;
};

export type TelemetryOption = {
  key: string;
  label: string;
};

export function normalizeVin(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

export function getSelectionStorageKey(vin: string) {
  return `suite.map-editor-maps.selection.${vin}`;
}

export function getProjectOptionLabel(option: ProjectOption) {
  return `${option.name} [${option.binName}]`;
}

export function getMapOptionLabel(map: Map) {
  return `${map.groupName ? `${map.groupName} / ` : ""}${map.name}`;
}

export function formatTelemetryLabel(label: string | null | undefined) {
  const trimmed = typeof label === "string" ? label.trim() : "";
  return trimmed ? formatLabel(trimmed) : "-";
}

export function formatAxisDescription(label: string | null | undefined) {
  const trimmed = typeof label === "string" ? label.trim() : "";
  if (!trimmed) return "";
  return trimmed.replace(/^([a-zåäö])/, (match) => match.toUpperCase());
}

export function longestLabelLength(labels: string[]) {
  return labels.reduce((max, label) => Math.max(max, label.length), 0);
}

export function estimateLabelWidthPx(
  chars: number,
  compactDensity: boolean,
  minWidth: number,
  maxWidth: number,
  extraPadding: number,
) {
  const charWidth = compactDensity ? 6.4 : 7.2;
  return Math.min(maxWidth, Math.max(minWidth, Math.ceil(chars * charWidth + extraPadding)));
}

export function normalizeErrorMessage(input: unknown, fallback: string) {
  if (typeof input === "string" && input.trim()) return input;

  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;

    if (typeof obj.message === "string" && obj.message.trim()) return obj.message;
    if (typeof obj.detail === "string" && obj.detail.trim()) return obj.detail;
    if (typeof obj.title === "string" && obj.title.trim()) return obj.title;

    try {
      return JSON.stringify(obj);
    } catch {
      return fallback;
    }
  }

  return fallback;
}

export function flattenProjects(items: Bin[]): ProjectOption[] {
  return items
    .flatMap((bin) =>
      (Array.isArray(bin.projects) ? bin.projects : []).map(
        (project): ProjectOption => ({
          ...project,
          active: "active" in project ? Boolean((project as { active?: unknown }).active) : false,
          binId: bin.id,
          binName: bin.name,
        }),
      ),
    )
    .sort((left: ProjectOption, right: ProjectOption) => {
      const activeDiff = Number(Boolean(right.active)) - Number(Boolean(left.active));
      if (activeDiff !== 0) return activeDiff;
      return left.name.localeCompare(right.name);
    });
}

export function getMatrixData(map: Map): (MapDataPoint | null)[][] {
  const matrix: (MapDataPoint | null)[][] = [];

  if (map.type === 1 && (!map.x || !map.y)) {
    matrix.push(map.data.map((point) => point || null));
    return matrix;
  }

  if (!map.x || !map.y) return matrix;

  const rows = map.y.length;
  const cols = map.x.length;

  for (let row = 0; row < rows; row++) {
    const rowData: (MapDataPoint | null)[] = [];
    for (let col = 0; col < cols; col++) {
      const index = map.type === 3 ? col * rows + row : row * cols + col;
      rowData.push(index < map.data.length ? map.data[index] : null);
    }
    matrix.push(rowData);
  }

  return matrix;
}

export function getMatrixLabels(map: Map): { xLabels: string[]; yLabels: string[] } {
  if (map.type === 1 && (!map.x || !map.y)) {
    return {
      xLabels: Array.from({ length: map.data.length }, (_, index) => `#${index + 1}`),
      yLabels: ["Value"],
    };
  }

  if (map.x && map.y) {
    return {
      xLabels: map.x.labels,
      yLabels: map.y.labels,
    };
  }

  return { xLabels: [], yLabels: [] };
}

export function getValueRange(map: Map) {
  const values = map.data
    .map((point) => point?.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (values.length === 0) {
    return { min: null, max: null };
  }

  return {
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

export function formatCellValue(value: number) {
  if (!Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 100) return value.toFixed(1);
  return value.toFixed(2);
}

export function formatRangeValue(value: number | null) {
  if (value == null) return "-";
  return formatCellValue(value);
}

export function parseAxisLabel(label: string, index: number): number {
  const cleaned = label.replace(/,/g, "").trim();
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : index;
}

export function findNearestIndex(labels: string[], value: number | null): number | null {
  if (!labels.length || value == null || !Number.isFinite(value)) return null;

  let bestIndex = 0;
  let bestDiff = Number.POSITIVE_INFINITY;

  labels.forEach((label, currentIndex) => {
    const axisValue = parseAxisLabel(label, currentIndex);
    const diff = Math.abs(axisValue - value);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = currentIndex;
    }
  });

  return bestIndex;
}

export function interpolatePixelPosition(
  labels: string[],
  centers: number[],
  value: number | null,
): number | null {
  if (!labels.length || !centers.length || value == null || !Number.isFinite(value)) return null;
  if (labels.length === 1 || centers.length === 1) return centers[0] ?? null;

  const axisValues = labels.map((label, index) => parseAxisLabel(label, index));
  if (axisValues.length !== centers.length) return centers[0] ?? null;

  for (let index = 0; index < axisValues.length - 1; index++) {
    const start = axisValues[index];
    const end = axisValues[index + 1];
    const min = Math.min(start, end);
    const max = Math.max(start, end);

    if (value < min || value > max) continue;

    const span = end - start;
    if (Math.abs(span) < 1e-9) return centers[index];

    const ratio = (value - start) / span;
    return centers[index] + (centers[index + 1] - centers[index]) * ratio;
  }

  if (value <= Math.min(axisValues[0], axisValues[1])) {
    return centers[0];
  }

  return centers[centers.length - 1];
}

export function buildTelemetryOptions(
  metaMap: Record<string, TelemetryParameterMeta>,
  values: Record<string, number>,
): TelemetryOption[] {
  const keys = new Set<string>([
    ...Object.keys(metaMap ?? {}),
    ...Object.keys(values ?? {}),
  ]);

  return Array.from(keys)
    .map((key) => {
      const meta = metaMap[key];
      const labelParts = [meta?.module, meta?.name || key].filter(Boolean);
      const unit = meta?.unit?.trim();

      return {
        key,
        label: unit ? `${labelParts.join(" / ")} [${unit}]` : labelParts.join(" / "),
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}
