import { writable } from "svelte/store";
import { getChartSnapshot } from "$lib/monitoring/telemetry.store";

export const telemetryWindow = writable<Window | null>(null);
export const telemetryIsPoppedOut = writable(false);

export const chartWindow = writable<Window | null>(null);
export const chartIsPoppedOut = writable(false);

export const mapWindow = writable<Window | null>(null);
export const mapIsPoppedOut = writable(false);
export const locationMapWindow = mapWindow;
export const locationMapIsPoppedOut = mapIsPoppedOut;

export const calibrationMapsWindow = writable<Window | null>(null);
export const calibrationMapsIsPoppedOut = writable(false);

// Map to track multiple value popout windows (key -> Window)
export const valuePopoutWindows = writable<Map<string, Window>>(new Map());

function createWindow(url: string, namePrefix: string) {
    const uniqueName = `${namePrefix}-${Date.now()}`;
    return window.open(url, uniqueName, "width=1400,height=400");
}

export function openTelemetryPopout() {
    const w = createWindow("/popout/telemetry", "TelemetryPopout");

    telemetryWindow.set(w);
    telemetryIsPoppedOut.set(true);

    let timer = setInterval(() => {
        telemetryWindow.update((current) => {
            if (!current || current.closed) {
                telemetryIsPoppedOut.set(false);
                clearInterval(timer);
                return null;
            }
            return current;
        });
    }, 400);
}

export function openChartPopout() {
    const w = createWindow("/popout/chart", "ChartPopout");

    chartWindow.set(w);
    chartIsPoppedOut.set(true);

    // Send the current chart snapshot to the popout window
    if (w) {
        const snap = getChartSnapshot();
        w.postMessage({ type: "chart:payload", payload: snap });
    }

    const timer = setInterval(() => {
        chartWindow.update((current) => {
            if (!current || current.closed) {
                chartIsPoppedOut.set(false);
                clearInterval(timer);
                return null;
            }
            return current;
        });
    }, 400);
}

export function openMapPopout() {
    const w = createWindow("/popout/location-map", "LocationMapPopout");

    mapWindow.set(w);
    mapIsPoppedOut.set(true);

    const timer = setInterval(() => {
        mapWindow.update((current) => {
            if (!current || current.closed) {
                mapIsPoppedOut.set(false);
                clearInterval(timer);
                return null;
            }
            return current;
        });
    }, 400);
}

export function openPlaceholderPopout() {
    const w = createWindow("/popout/calibration-maps", "CalibrationMapsPopout");

    calibrationMapsWindow.set(w);
    calibrationMapsIsPoppedOut.set(true);

    let timer = setInterval(() => {
        calibrationMapsWindow.update((current) => {
            if (!current || current.closed) {
                calibrationMapsIsPoppedOut.set(false);
                clearInterval(timer);
                return null;
            }
            return current;
        });
    }, 400);
}

export function closeTelemetryPopout() {
    const w = getWindow(telemetryWindow);
    if (w) w.close();
    telemetryWindow.set(null);
    telemetryIsPoppedOut.set(false);
}

export function closeChartPopout() {
    const w = getWindow(chartWindow);
    if (w) w.close();
    chartWindow.set(null);
    chartIsPoppedOut.set(false);
}

export function closeMapPopout() {
    const w = getWindow(mapWindow);
    if (w) w.close();
    mapWindow.set(null);
    mapIsPoppedOut.set(false);
}

export function closePlaceholderPopout() {
    const w = getWindow(calibrationMapsWindow);
    if (w) w.close();
    calibrationMapsWindow.set(null);
    calibrationMapsIsPoppedOut.set(false);
}

export const closeCalibrationMapsPopout = closePlaceholderPopout;

export const closeLocationMapPopout = closeMapPopout;

export const openCalibrationMapsPopout = openPlaceholderPopout;

export const openLocationMapPopout = openMapPopout;

export function focusTelemetryPopout() {
    focusWindow(telemetryWindow);
}

export function focusChartPopout() {
    focusWindow(chartWindow);
}

export function focusMapPopout() {
    focusWindow(mapWindow);
}

export const focusLocationMapPopout = focusMapPopout;

export function focusPlaceholderPopout() {
    focusWindow(calibrationMapsWindow);
}

export const focusCalibrationMapsPopout = focusPlaceholderPopout;

export function openValuePopout(key: string): boolean {
    // Check if window already exists for this key
    let existingWindow: Window | null = null;
    valuePopoutWindows.update((map) => {
        existingWindow = map.get(key) || null;
        return map;
    });

    // If window exists and is not closed, focus it
    if (existingWindow && !existingWindow.closed) {
        existingWindow.focus();
        return true;
    }

    // Create new window with key as query parameter
    const w = createWindow(`/popout/telemetry-value?key=${encodeURIComponent(key)}`, `ValuePopout-${key}`);

    if (w) {
        valuePopoutWindows.update((map) => {
            const newMap = new Map(map);
            newMap.set(key, w);
            return newMap;
        });

        // Monitor window closure
        let timer = setInterval(() => {
            valuePopoutWindows.update((map) => {
                const current = map.get(key);
                if (!current || current.closed) {
                    clearInterval(timer);
                    const newMap = new Map(map);
                    newMap.delete(key);
                    return newMap;
                }
                return map;
            });
        }, 400);

        return true;
    }

    // If we failed to open a window (likely due to a popup blocker),
    // signal failure so the caller can react accordingly.
    return false;
}

export function closeValuePopout(key: string) {
    let targetWindow: Window | null = null;
    valuePopoutWindows.update((map) => {
        const win = map.get(key);
        targetWindow = win !== undefined ? win : null;
        const newMap = new Map(map);
        newMap.delete(key);
        return newMap;
    });
    // Ask the value popout window to close itself. Calling w.close() from the
    // main window can fail when the user gesture happened in another window
    // (e.g. telemetry popout). A window can always close itself reliably.
    const win = targetWindow as Window | null;
    if (win && !win.closed) {
        try {
            win.postMessage({ type: "value-popout:close" }, "*");
        } catch {
            win.close();
        }
    }
}

import type { Writable } from "svelte/store";

function getWindow(store: Writable<Window | null>): Window | null {
    let win: Window | null = null;

    const unsubscribe = store.subscribe((v) => {
        win = v;
    });

    unsubscribe();
    return win;
}

function focusWindow(store: Writable<Window | null>) {
    const w = getWindow(store);
    if (w && !w.closed) {
        w.focus();
    }
}

