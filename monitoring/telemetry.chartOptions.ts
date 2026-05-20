import * as echarts from 'echarts';
import type { ComposeOption } from 'echarts/core';
import type {
  LineSeriesOption,
  GaugeSeriesOption,
  BarSeriesOption,
  ScatterSeriesOption,
} from 'echarts/charts';
import type {
  TitleComponentOption,
  TooltipComponentOption,
  GridComponentOption,
  DataZoomComponent,
} from 'echarts/components';
import type { TelemetryParameterMeta } from './telemetry.domain';
import { formatLabel, formatTelemetryValue } from './formatters';
import {
  chunkTooltipRows,
  DEFAULT_TOOLTIP_OPACITY,
  getCursorAnchoredTooltipPosition,
  getTooltipSurfaceStyle,
  TOOLTIP_MAX_ROWS_PER_COLUMN,
} from '../chart-tooltip';

export type ChartType = 'line' | 'gauge' | 'gauge-pressure';

/**
 * Round a number to the nearest 10
 */
function roundToNearest10(value: number): number {
  return Math.round(value / 10) * 10;
}

/**
 * Round min/max values to nearest 10s with some padding
 */
function roundGaugeRange(min: number, max: number): { min: number; max: number } {
  // Round min down and max up to nearest 10
  const roundedMin = Math.floor(min / 10) * 10;
  const roundedMax = Math.ceil(max / 10) * 10;

  // Add some padding (10 units on each side)
  return {
    min: roundedMin - 10,
    max: roundedMax + 10,
  };
}

/**
 * Combined ECharts option type used for the telemetry line chart.
 * This keeps the chart definition strongly typed.
 */
export type ECOption = ComposeOption<
  | LineSeriesOption
  | TitleComponentOption
  | TooltipComponentOption
  | GridComponentOption
  | echarts.DataZoomComponentOption
>;

// Re-export echarts so consumers can use the same instance type.
export { echarts };

export function sliceTelemetryWindowData(
  labels: string[],
  histories: Record<string, number[]>,
  windowSeconds: number,
): { labels: string[]; histories: Record<string, number[]> } {
  if (labels.length === 0) {
    return { labels, histories };
  }

  const safeWindowSeconds = Number.isFinite(windowSeconds) ? Math.max(10, windowSeconds) : 10;
  const lastTimestamp = Number(labels[labels.length - 1]);

  if (!Number.isFinite(lastTimestamp)) {
    return { labels, histories };
  }

  const cutoffTimestamp = lastTimestamp - safeWindowSeconds * 1000;
  let startIndex = 0;

  while (startIndex < labels.length - 1) {
    const timestamp = Number(labels[startIndex]);
    if (!Number.isFinite(timestamp) || timestamp >= cutoffTimestamp) break;
    startIndex += 1;
  }

  if (startIndex <= 0) {
    return { labels, histories };
  }

  const slicedLabels = labels.slice(startIndex);
  const keepCount = slicedLabels.length;
  const slicedHistories = Object.fromEntries(
    Object.entries(histories).map(([key, values]) => [
      key,
      values.length > keepCount ? values.slice(values.length - keepCount) : values.slice(),
    ]),
  );

  return {
    labels: slicedLabels,
    histories: slicedHistories,
  };
}

/**
 * Localized time formatter for the X-axis labels.
 * Uses the client's current locale and timezone to display HH:mm:ss.
 */
const localTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * Base configuration for a telemetry line series.
 * Shared across all series to ensure consistent visual behavior.
 */
export const baseLineSeries: Omit<LineSeriesOption, 'label' | 'data'> = {
  type: 'line',
  smooth: true,
  showSymbol: false,
};

/**
 * Base chart option used as a template for all telemetry charts.
 * This is later merged with dynamic data, series definitions and theme overrides.
 */
export const baseOption: ECOption = {
  animation: true,
  animationDuration: 0,
  animationDurationUpdate: 45,
  animationEasingUpdate: 'linear',

  tooltip: { trigger: 'axis' },
  grid: {
    left: 30,
    right: 10,
    top: 40,
    bottom: 50,
    containLabel: true,
  },
  xAxis: {
    type: 'category',
    data: [],
  },
  yAxis: {
    type: 'value',
    name: '',
  },
  series: [],

  dataZoom: [
    {
      type: 'inside',
      xAxisIndex: 0,
      zoomOnMouseWheel: true,
      moveOnMouseWheel: false,
      minSpan: 40,
      maxSpan: 120,
    },
    {
      type: 'slider',
      xAxisIndex: 0,

      handleSize: 0,
      moveHandleSize: 0,
      brushSelect: false,

      left: 10,
      right: 10,
      minSpan: 40,
      maxSpan: 120,
    },
  ],
};

/**
 * Base color palette used for telemetry series.
 * If we run out of colors in this list, we will generate random colors.
 * (Inspired by the app's chart implementation.)
 */
const BASE_COLORS: string[] = [
  '#FFD700',
  '#FF4500',
  '#FF69B4',
  '#ADFF2F',
  '#7CFC00',
  '#FF1493',
  '#FFA500',
  '#F0E68C',
  '#00FF7F',
  '#FF6347',
];

/**
 * Generate a random hex color that is not already in the excluded set.
 */
function generateRandomColor(exclude: Set<string>): string {
  let color = '#000000';

  do {
    color =
      '#' +
      Math.floor(Math.random() * 0xffffff)
        .toString(16)
        .padStart(6, '0');
  } while (exclude.has(color));

  return color;
}

/**
 * Resolve a stable color for a given telemetry key.
 *
 * Strategy:
 *  - If the key already has a color in seriesColors => reuse it.
 *  - Otherwise, pick the first unused color from BASE_COLORS.
 *  - If all BASE_COLORS are used, generate a random unique color.
 *
 * The resolved color is stored back into seriesColors so it remains stable
 * across chart updates and toggling.
 */
function getColorForKey(key: string, index: number, seriesColors: Record<string, string>): string {
  // 1) Reuse existing color if available
  const existing = seriesColors[key];
  if (existing) return existing;

  // 2) Compute which colors are already in use
  const used = new Set(Object.values(seriesColors));

  // 3) Try to pick a color from the base palette.
  //    We start from "index" to keep things somewhat deterministic
  //    relative to the series position, but without reusing colors.
  for (let offset = 0; offset < BASE_COLORS.length; offset++) {
    const candidate = BASE_COLORS[(index + offset) % BASE_COLORS.length];
    if (!used.has(candidate)) {
      seriesColors[key] = candidate;
      return candidate;
    }
  }

  // 4) Fallback: all base colors are used, generate a new unique color
  const random = generateRandomColor(used);
  seriesColors[key] = random;
  return random;
}

/**
 * Ensures every key has a stable color in the returned map.
 * Use this in stores so tiles keep colors even when the chart component is not mounted.
 */
export function ensureSeriesColors(
  keys: string[],
  seriesColors: Record<string, string>,
): Record<string, string> {
  const next = { ...seriesColors };
  const orderedKeys = [...keys].sort(); // deterministic assignment

  orderedKeys.forEach((key, index) => {
    getColorForKey(key, index, next);
  });

  return next;
}

/**
 * Builds a complete ECharts option object for the telemetry chart.
 * Intended to be merged with the existing chart instance.
 *
 * Parameters:
 *  - labels:
 *      Array of timestamp strings, one per telemetry frame. These are mapped to localized
 *      time strings and used as X-axis labels.
 *
 *  - histories:
 *      Historical numeric values per telemetry key. Structure:
 *      {
 *        "Vehicle#Speed#5": [12, 14, 15, ...],
 *        "Vehicle#Airmas#27": [102, 104, 103, ...]
 *      }
 *
 *  - meta:
 *      Metadata map keyed by telemetry key, used to provide human-readable names and units.
 *      Example:
 *      {
 *        "Vehicle#Speed#5": { name: "Vehicle Speed", unit: "KPH", ... }
 *      }
 *
 *  - enabledKeys:
 *      List of keys that are currently enabled/visible in the chart.
 *      An empty list results in no visible series.
 *
 *  - seriesColors:
 *      Optional map of key -> CSS color string. Existing entries are reused; undefined
 *      entries will be assigned a new color from BASE_COLORS (or a random color if exhausted).
 *      The object is treated as mutable and can be persisted by the caller.
 *
 *  - tooltipOpacity:
 *      Opacity used for the chart tooltip chrome. Expected range is 0.2 - 1.0.
 */

export function buildTelemetryOption(
  labels: string[],
  histories: Record<string, number[]>,
  meta: Record<string, TelemetryParameterMeta>,
  enabledKeys: string[] = [],
  seriesColors: Record<string, string> = {},
  highlightedSeriesKey: string | null = null,
  tooltipOpacity: number = DEFAULT_TOOLTIP_OPACITY,
): ECOption {
  // Evaluate theme based on a global data-theme attribute set on the <html> element.
  const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';

  const textColor = isDarkMode ? '#e8e8e8' : '#000000';
  const gridLineColor = isDarkMode ? '#3a4150' : '#e0e0e0';
  const axisLineColor = isDarkMode ? '#5a7a8a' : '#333';
  const tooltipSurface = getTooltipSurfaceStyle(isDarkMode, tooltipOpacity);

  const axisLabelStyle = { color: textColor };

  /**
   * Determine which telemetry keys should be included as series:
   *  - The key must have at least one data point.
   *  - Only keys explicitly present in enabledKeys are included.
   *    An empty enabledKeys array results in no visible series.
   */
  const activeKeys = Object.keys(histories).filter((key) => {
    const data = histories[key];
    if (!data || data.length === 0) return false;
    return enabledKeys.includes(key);
  });
  const effectiveHighlightedSeriesKey =
    highlightedSeriesKey && activeKeys.includes(highlightedSeriesKey) ? highlightedSeriesKey : null;

  /**
   * Convert values to percentage (0-100%) for both main window and popout.
   * Based on min/max from meta (the model).
   */
  const processedHistories: Record<string, number[]> = {};
  // For both main window and popout: convert to percentage
  for (const key of activeKeys) {
    const data = histories[key] ?? [];
    const m = meta[key];

    // Use min/max from meta if available, otherwise fallback to calculating from data
    let minValue: number | undefined;
    let maxValue: number | undefined;

    if (m?.min !== undefined && m?.max !== undefined) {
      // Use min/max from meta
      minValue = m.min;
      maxValue = m.max;
    } else if (data.length > 0) {
      // Fallback: calculate from data if meta lacks min/max
      minValue = Math.min(...data);
      maxValue = Math.max(...data);
    }

    if (minValue !== undefined && maxValue !== undefined && maxValue !== minValue) {
      // Konvertera till procent: ((value - min) / (max - min)) * 100
      processedHistories[key] = data.map(
        (value) => ((value - minValue!) / (maxValue! - minValue!)) * 100,
      );
    } else if (minValue !== undefined && maxValue !== undefined && maxValue === minValue) {
      // If min === max, show 50% or 0%
      processedHistories[key] = data.map(() => (minValue === 0 ? 0 : 50));
    } else {
      // If no min/max exists, use original values
      processedHistories[key] = data;
    }
  }

  /**
   * Build a LineSeriesOption for each active key.
   * The series name is built from metadata (name + unit) when available,
   * otherwise the raw key is used as a fallback.
   *
   * A stable color is applied from seriesColors. New keys are assigned
   * colors using BASE_COLORS or a generated random color.
   */
  const series: LineSeriesOption[] = activeKeys.map((key, index) => {
    const data = processedHistories[key] ?? [];
    const m = meta[key];

    const displayName = m ? [m.name, m.unit && `(${m.unit})`].filter(Boolean).join(' ') : key;

    // Resolve stable color for this key (mutates seriesColors)
    const color = getColorForKey(key, index, seriesColors);
    const isHighlighted = !effectiveHighlightedSeriesKey || effectiveHighlightedSeriesKey === key;

    return {
      ...baseLineSeries,
      id: key,
      name: formatLabel(displayName),
      data,
      lineStyle: {
        ...(baseLineSeries.lineStyle ?? {}),
        color,
        width: isHighlighted ? 2.5 : 1.6,
        opacity: isHighlighted ? 1 : 0.16,
      },
      itemStyle: {
        color,
        opacity: isHighlighted ? 1 : 0.16,
      },
      z: isHighlighted ? 3 : 1,
    };
  });

  /**
   * Map raw timestamp strings into localized time labels.
   * Non-numeric or invalid values are converted to empty labels.
   */
  const formattedLabels = labels.map((raw) => {
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return '';
    return localTimeFormatter.format(new Date(ts));
  });

  /**
   * Merge the base option with:
   *  - formatted X-axis labels
   *  - theme-aware axis styling
   *  - generated series list
   *  - tooltip: show actual values (not percentage)
   */
  return {
    ...baseOption,
    tooltip: {
      trigger: 'axis',
      confine: false,
      appendToBody: true,
      backgroundColor: tooltipSurface.backgroundColor,
      borderColor: tooltipSurface.borderColor,
      borderWidth: 1,
      textStyle: {
        color: tooltipSurface.textColor,
      },
      position: (point: number[], _params: unknown, _dom: unknown, _rect: unknown, size: any) =>
        getCursorAnchoredTooltipPosition(point, size),
      formatter: (params: any) => {
        if (!Array.isArray(params) || params.length === 0) return '';
        const timeLabel = params[0].axisValue || '';
        const dataIndex = params[0].dataIndex;
        const rows: string[] = [];

        for (const param of params) {
          const seriesName = param.seriesName;
          const seriesId = param.seriesId;

          // Find the original value from histories based on seriesId and dataIndex
          if (seriesId && histories[seriesId] && dataIndex !== undefined) {
            const originalValue = histories[seriesId][dataIndex];
            const m = meta[seriesId];
            const unit = m?.unit ? ` ${m.unit}` : '';

            if (originalValue !== undefined && originalValue !== null) {
              rows.push(
                `<div style="white-space:nowrap;">${param.marker}${seriesName}: ${formatTelemetryValue(originalValue, 3)}${unit}</div>`,
              );
            } else {
              rows.push(`<div style="white-space:nowrap;">${param.marker}${seriesName}: -</div>`);
            }
          } else {
            // Fallback if we cannot find the original value
            rows.push(`<div style="white-space:nowrap;">${param.marker}${seriesName}: -</div>`);
          }
        }

        const columnsHtml = chunkTooltipRows(rows, TOOLTIP_MAX_ROWS_PER_COLUMN)
          .map(
            (colRows) =>
              `<div style="display:flex;flex-direction:column;gap:2px;min-width:230px;">${colRows.join('')}</div>`,
          )
          .join('');

        return [
          `<div style="font-weight:600;margin-bottom:6px;white-space:nowrap;">${timeLabel}</div>`,
          `<div style="display:flex;align-items:flex-start;gap:14px;">${columnsHtml}</div>`,
        ].join('');
      },
    },

    xAxis: {
      ...(baseOption.xAxis as any),
      data: formattedLabels,
      axisLabel: axisLabelStyle,
      splitLine: {
        lineStyle: {
          color: gridLineColor,
        },
      },
      axisLine: {
        lineStyle: {
          color: axisLineColor,
        },
      },
    },
    yAxis: {
      ...(baseOption.yAxis as any),
      type: 'value',
      min: 0,
      max: 100,
      axisLabel: { show: false },
      splitLine: {
        lineStyle: {
          color: gridLineColor,
        },
      },
      axisLine: {
        lineStyle: {
          color: axisLineColor,
        },
      },
    },
    series,
  };
}

/**
 * Build chart option for a single value with different chart types.
 * Used in value popout windows.
 */
export function buildSingleValueChartOption(
  chartType: ChartType,
  labels: string[],
  history: number[],
  meta: TelemetryParameterMeta | undefined,
  color: string,
  fixedGaugeMin: number | null = null,
  fixedGaugeMax: number | null = null,
  minValue: number | null = null,
  maxValue: number | null = null,
  chartWidth: number = 0,
  chartHeight: number = 0,
): any {
  const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDarkMode ? '#e8e8e8' : '#000000';
  const gridLineColor = isDarkMode ? '#3a4150' : '#e0e0e0';
  const axisLineColor = isDarkMode ? '#5a7a8a' : '#333';
  const axisLabelStyle = { color: textColor };

  const displayName = meta
    ? [meta.name, meta.unit && `(${meta.unit})`].filter(Boolean).join(' ')
    : 'Value';

  const formattedLabels = labels.map((raw) => {
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return '';
    return localTimeFormatter.format(new Date(ts));
  });

  // Get current/latest value
  const currentValue = history.length > 0 ? history[history.length - 1] : 0;

  // Calculate min/max if not provided
  const calculatedMin =
    minValue !== null ? minValue : history.length > 0 ? Math.min(...history) : null;
  const calculatedMax =
    maxValue !== null ? maxValue : history.length > 0 ? Math.max(...history) : null;

  // Format min/max for tooltip
  const formatMinMax = (val: number | null): string => {
    if (val === null) return '';
    return `${formatTelemetryValue(val, 3)}${meta?.unit ? ` ${meta.unit}` : ''}`;
  };

  const minMaxText =
    calculatedMin !== null && calculatedMax !== null
      ? `<br/>Min: ${formatMinMax(calculatedMin)}<br/>Max: ${formatMinMax(calculatedMax)}`
      : '';
  const smallestChartSide = Math.min(
    chartWidth || Number.POSITIVE_INFINITY,
    chartHeight || Number.POSITIVE_INFINITY,
  );
  let gaugeDetailFontSize = 20;

  if (chartType !== 'line') {
    if ((chartWidth > 0 && chartWidth < 420) || smallestChartSide < 280) {
      gaugeDetailFontSize = 14;
    } else if ((chartWidth > 0 && chartWidth < 520) || smallestChartSide < 340) {
      gaugeDetailFontSize = 16;
    }
  }

  if (chartType === 'gauge' || chartType === 'gauge-pressure') {
    // Gauge chart - shows current value like a speedometer or pressure gauge
    // Priority: 1) fixed values, 2) metadata min/max, 3) calculated from history, 4) defaults
    let gaugeMin: number;
    let gaugeMax: number;

    if (fixedGaugeMin !== null && fixedGaugeMax !== null) {
      // Use fixed values to prevent gauge from changing scale
      gaugeMin = fixedGaugeMin;
      gaugeMax = fixedGaugeMax;
    } else if (meta?.min !== undefined && meta?.max !== undefined) {
      // Use min/max from metadata (round to nearest 10)
      const range = roundGaugeRange(meta.min, meta.max);
      gaugeMin = range.min;
      gaugeMax = range.max;
    } else if (history.length > 0) {
      // Calculate initial values and round to nearest 10
      const minValue = Math.min(...history);
      const maxValue = Math.max(...history);
      const range = roundGaugeRange(minValue, maxValue);
      gaugeMin = range.min;
      gaugeMax = range.max;
    } else {
      // Fallback defaults
      gaugeMin = 0;
      gaugeMax = 100;
    }

    // Speedometer style gauge (semicircle)
    if (chartType === 'gauge') {
      return {
        animation: true,
        animationDuration: 0,
        animationDurationUpdate: 40,
        animationEasingUpdate: 'linear',
        tooltip: {
          formatter: (params: { seriesName: string; name: string; value: number }) =>
            `${params.seriesName} <br/>${params.name} : ${formatTelemetryValue(params.value, 3)}${meta?.unit ? ` ${meta.unit}` : ''}${minMaxText}`,
        },
        grid: {
          left: '10%',
          right: '10%',
          top: '15%',
          bottom: '15%',
          width: '80%',
          height: '70%',
        },
        xAxis: { show: false },
        yAxis: { show: false },
        dataZoom: [],
        series: [
          {
            name: formatLabel(displayName),
            type: 'gauge',
            min: gaugeMin,
            max: gaugeMax,
            splitNumber: 8,
            radius: '75%',
            center: ['50%', '55%'],
            startAngle: 200,
            endAngle: -20,
            axisLine: {
              lineStyle: {
                color: [[1, color]],
                width: 10,
              },
            },
            pointer: {
              itemStyle: {
                color: 'auto',
              },
            },
            axisTick: {
              distance: -30,
              length: 8,
              lineStyle: {
                color: '#fff',
                width: 1,
              },
            },
            splitLine: {
              distance: -30,
              length: 14,
              lineStyle: {
                color: '#fff',
                width: 2,
              },
            },
            axisLabel: {
              color: textColor,
              distance: -20,
              rotate: 'tangential',
              fontSize: 12,
              formatter: (value: number) => {
                // Only show min and max values
                if (value === gaugeMin || value === gaugeMax) {
                  return value.toString();
                }
                return '';
              },
            },
            title: {
              show: false,
            },
            detail: {
              valueAnimation: true,
              formatter: (value: number) =>
                `${formatTelemetryValue(value, 3)}${meta?.unit ? ` ${meta.unit}` : ''}`,
              color: textColor,
              fontSize: gaugeDetailFontSize,
              offsetCenter: [
                0,
                gaugeDetailFontSize <= 14 ? '80%' : gaugeDetailFontSize <= 16 ? '76%' : '70%',
              ],
            },
            data: [
              {
                value: currentValue,
                name: formatLabel(displayName),
              },
            ],
          },
        ],
      };
    }

    // Pressure gauge style (full circle)
    return {
      animation: true,
      animationDuration: 0,
      animationDurationUpdate: 40,
      animationEasingUpdate: 'linear',
      tooltip: {
        formatter: (params: { seriesName: string; name: string; value: number }) =>
          `${params.seriesName} <br/>${params.name} : ${formatTelemetryValue(params.value, 3)}${meta?.unit ? ` ${meta.unit}` : ''}${minMaxText}`,
      },
      grid: {
        left: '10%',
        right: '10%',
        top: '15%',
        bottom: '15%',
        width: '80%',
        height: '70%',
      },
      xAxis: { show: false },
      yAxis: { show: false },
      dataZoom: [],
      series: [
        {
          name: formatLabel(displayName),
          type: 'gauge',
          min: gaugeMin,
          max: gaugeMax,
          splitNumber: 10,
          radius: '72%',
          center: ['50%', '48%'],
          startAngle: 225,
          endAngle: -45,
          axisLine: {
            lineStyle: {
              color: [
                [0.3, '#67e0e3'],
                [0.7, '#37a2da'],
                [1, '#fd666d'],
              ],
              width: 15,
            },
          },
          pointer: {
            itemStyle: {
              color: 'auto',
              shadowColor: 'rgba(0, 0, 0, 0.5)',
              shadowBlur: 10,
            },
            width: 5,
          },
          axisTick: {
            distance: -25,
            length: 10,
            lineStyle: {
              color: textColor,
              width: 1,
            },
          },
          splitLine: {
            distance: -30,
            length: 15,
            lineStyle: {
              color: textColor,
              width: 2,
            },
          },
          axisLabel: {
            color: textColor,
            distance: -18,
            rotate: 'tangential',
            fontSize: 12,
            formatter: (value: number) => {
              // Only show min and max values
              if (value === gaugeMin || value === gaugeMax) {
                return value.toString();
              }
              return '';
            },
          },
          title: {
            show: false,
          },
          detail: {
            valueAnimation: true,
            formatter: (value: number) =>
              `${formatTelemetryValue(value, 3)}${meta?.unit ? ` ${meta.unit}` : ''}`,
            color: textColor,
            fontSize: gaugeDetailFontSize,
            fontWeight: 'bold',
            offsetCenter: [
              0,
              gaugeDetailFontSize <= 14 ? '96%' : gaugeDetailFontSize <= 16 ? '92%' : '78%',
            ],
          },
          data: [
            {
              value: currentValue,
              name: formatLabel(displayName),
            },
          ],
        },
      ],
    };
  }

  // Common options for time-based charts
  const baseTimeChart = {
    animation: true,
    animationDuration: 0,
    animationDurationUpdate: 40,
    animationEasingUpdate: 'linear',
    tooltip: {
      trigger: 'axis',
      formatter: (params: any) => {
        if (Array.isArray(params)) {
          const param = params[0];
          return `${param.seriesName}<br/>${param.name}<br/>${param.marker}${formatTelemetryValue(param.value, 3)}${meta?.unit ? ` ${meta.unit}` : ''}${minMaxText}`;
        } else {
          return `${params.seriesName}<br/>${params.name}<br/>${params.marker}${formatTelemetryValue(params.value, 3)}${meta?.unit ? ` ${meta.unit}` : ''}${minMaxText}`;
        }
      },
    },
    grid: {
      left: 30,
      right: 10,
      top: 40,
      bottom: 50,
      containLabel: true,
    },
    xAxis: {
      type: 'category',
      data: formattedLabels,
      axisLabel: axisLabelStyle,
      splitLine: {
        lineStyle: { color: gridLineColor },
      },
      axisLine: {
        lineStyle: { color: axisLineColor },
      },
    },
    yAxis: {
      type: 'value',
      name: meta?.unit || 'value',
      nameLocation: 'middle',
      nameTextStyle: {
        color: textColor,
        padding: 30,
        fontSize: 14,
        fontWeight: 'bold',
      },
      axisLabel: axisLabelStyle,
      splitLine: {
        lineStyle: { color: gridLineColor },
      },
      axisLine: {
        lineStyle: { color: axisLineColor },
      },
    },
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        zoomOnMouseWheel: true,
        moveOnMouseWheel: false,
        minSpan: 40,
        maxSpan: 120,
      },
      {
        type: 'slider',
        xAxisIndex: 0,
        handleSize: 0,
        moveHandleSize: 0,
        brushSelect: false,
        left: 10,
        right: 10,
        minSpan: 40,
        maxSpan: 120,
      },
    ],
  };

  // Default: line chart
  return {
    ...baseTimeChart,
    series: [
      {
        name: formatLabel(displayName),
        type: 'line',
        data: history,
        smooth: true,
        showSymbol: false,
        lineStyle: { color, width: 2 },
        itemStyle: { color },
      },
    ],
  };
}
