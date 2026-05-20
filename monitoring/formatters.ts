export function formatLabel(input: string): string {
    return input.replace(/(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)/g, " ");
}

export function normalizeForSearch(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

export function formatTelemetryValue(
  value: number | string | null | undefined,
  decimals = 3,
): string {
  if (value === null || value === undefined) return "-";

  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(numeric)) {
    return String(value);
  }

  return numeric.toLocaleString(undefined, {
    maximumFractionDigits: decimals,
    minimumFractionDigits: 0,
    useGrouping: false,
  });
}
