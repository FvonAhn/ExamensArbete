import type { Map } from "../../utils/types";
import type { TelemetryParameterMeta } from "./telemetry.domain";
import {
  buildTelemetryOptions,
  findNearestIndex,
  getMatrixLabels,
  getValueRange,
  type TelemetryOption,
} from "./calibration-maps.utils";

export type CalibrationMapsLayout = {
  useSplitMenuLayout: boolean;
  showCompactMenu: boolean;
  showSidebarMenu: boolean;
  useSidebarPopoutStyle: boolean;
  isFocusMode: boolean;
  allowMatrixScrollViewport: boolean;
  hideMatrixScrollbars: boolean;
  lockMatrixViewport: boolean;
  isNarrowPanel: boolean;
  isShortPanel: boolean;
  isWideShortPanel: boolean;
  useCompactSidebarLayout: boolean;
  showCompactPreview: boolean;
  mapActionLabel: string;
};

export function getCalibrationMapsLayout(
  panelShellWidth: number,
  panelShellHeight: number,
  isPopout: boolean,
  showMapView: boolean,
): CalibrationMapsLayout {
  const useSplitMenuLayout = isPopout || panelShellWidth >= 1100;
  const showCompactMenu = !showMapView && !useSplitMenuLayout;
  const showSidebarMenu = !showMapView && useSplitMenuLayout;
  const useSidebarPopoutStyle = showSidebarMenu;
  const isFocusMode = showMapView;
  const allowMatrixScrollViewport =
    useSidebarPopoutStyle ||
    isFocusMode ||
    (panelShellWidth > 0 && panelShellWidth < 1280) ||
    (panelShellHeight > 0 && panelShellHeight < 640);
  const hideMatrixScrollbars = useSidebarPopoutStyle || isFocusMode ? true : !allowMatrixScrollViewport;
  const lockMatrixViewport = useSidebarPopoutStyle || isFocusMode ? true : !allowMatrixScrollViewport;
  const isNarrowPanel = panelShellWidth > 0 && panelShellWidth < 420;
  const isShortPanel = panelShellHeight > 0 && panelShellHeight < 260;
  const isWideShortPanel = panelShellWidth > 720 && panelShellHeight > 0 && panelShellHeight < 280;
  const useCompactSidebarLayout = showSidebarMenu && panelShellHeight > 0 && panelShellHeight < 240;
  const showCompactPreview = showCompactMenu && panelShellHeight >= 360;
  const mapActionLabel = showSidebarMenu || showCompactPreview ? "Expand Map" : "View Map";

  return {
    useSplitMenuLayout,
    showCompactMenu,
    showSidebarMenu,
    useSidebarPopoutStyle,
    isFocusMode,
    allowMatrixScrollViewport,
    hideMatrixScrollbars,
    lockMatrixViewport,
    isNarrowPanel,
    isShortPanel,
    isWideShortPanel,
    useCompactSidebarLayout,
    showCompactPreview,
    mapActionLabel,
  };
}

export type CalibrationMapsViewModel = {
  telemetryOptions: TelemetryOption[];
  selectedMapLabels: { xLabels: string[]; yLabels: string[] };
  hasMultipleXValues: boolean;
  hasMultipleYValues: boolean;
  selectedXTelemetryKey: string;
  selectedYTelemetryKey: string;
  selectedXMeta: TelemetryParameterMeta | null;
  selectedYMeta: TelemetryParameterMeta | null;
  selectedMapRange: { min: number | null; max: number | null };
  currentXValue: number | null;
  currentYValue: number | null;
  activeRowIndex: number | null;
  activeColIndex: number | null;
};

export function getCalibrationMapsViewModel(input: {
  selectedMap: Map | null;
  activeParameterMeta: Record<string, TelemetryParameterMeta>;
  activeTelemetryValues: Record<string, number>;
  selectedXTelemetryKey: string;
  selectedYTelemetryKey: string;
}): CalibrationMapsViewModel {
  const telemetryOptions = buildTelemetryOptions(input.activeParameterMeta, input.activeTelemetryValues);
  const selectedMapLabels = input.selectedMap ? getMatrixLabels(input.selectedMap) : { xLabels: [], yLabels: [] };
  const hasMultipleXValues = selectedMapLabels.xLabels.length > 1;
  const hasMultipleYValues = selectedMapLabels.yLabels.length > 1;

  const selectedXTelemetryKey =
    hasMultipleXValues &&
    input.selectedXTelemetryKey &&
    (telemetryOptions.length === 0 || telemetryOptions.some((option) => option.key === input.selectedXTelemetryKey))
      ? input.selectedXTelemetryKey
      : "";

  const selectedYTelemetryKey =
    hasMultipleYValues &&
    input.selectedYTelemetryKey &&
    (telemetryOptions.length === 0 || telemetryOptions.some((option) => option.key === input.selectedYTelemetryKey))
      ? input.selectedYTelemetryKey
      : "";

  const selectedXMeta = selectedXTelemetryKey ? input.activeParameterMeta[selectedXTelemetryKey] ?? null : null;
  const selectedYMeta = selectedYTelemetryKey ? input.activeParameterMeta[selectedYTelemetryKey] ?? null : null;
  const selectedMapRange = input.selectedMap ? getValueRange(input.selectedMap) : { min: null, max: null };

  const currentXValue =
    hasMultipleXValues &&
    selectedXTelemetryKey &&
    typeof input.activeTelemetryValues[selectedXTelemetryKey] === "number"
      ? input.activeTelemetryValues[selectedXTelemetryKey]
      : null;

  const currentYValue =
    hasMultipleYValues &&
    selectedYTelemetryKey &&
    typeof input.activeTelemetryValues[selectedYTelemetryKey] === "number"
      ? input.activeTelemetryValues[selectedYTelemetryKey]
      : null;

  const activeRowIndex = hasMultipleYValues
    ? findNearestIndex(selectedMapLabels.yLabels, currentYValue)
    : selectedMapLabels.yLabels.length > 0
      ? 0
      : null;

  const activeColIndex = hasMultipleXValues
    ? findNearestIndex(selectedMapLabels.xLabels, currentXValue)
    : selectedMapLabels.xLabels.length > 0
      ? 0
      : null;

  return {
    telemetryOptions,
    selectedMapLabels,
    hasMultipleXValues,
    hasMultipleYValues,
    selectedXTelemetryKey,
    selectedYTelemetryKey,
    selectedXMeta,
    selectedYMeta,
    selectedMapRange,
    currentXValue,
    currentYValue,
    activeRowIndex,
    activeColIndex,
  };
}
