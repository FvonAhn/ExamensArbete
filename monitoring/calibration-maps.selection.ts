import { getSelectionStorageKey } from "./calibration-maps.utils";

export type CalibrationMapsSelection = {
  projectValue?: string;
  mapValue?: string;
  xKey?: string;
  yKey?: string;
  showMapView?: boolean;
};

export function loadCalibrationMapsSelection(vin: string): CalibrationMapsSelection | null {
  if (typeof localStorage === "undefined" || !vin) return null;

  try {
    const raw = localStorage.getItem(getSelectionStorageKey(vin));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as CalibrationMapsSelection;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function saveCalibrationMapsSelection(vin: string, selection: CalibrationMapsSelection): void {
  if (typeof localStorage === "undefined" || !vin) return;

  try {
    localStorage.setItem(getSelectionStorageKey(vin), JSON.stringify(selection));
  } catch {
    // Ignore storage failures so the panel keeps working.
  }
}
