import { writable, get } from "svelte/store";
import { selectedDeviceId } from "./telemetry.session.store";
import { vehicleName, vehicleVin, parameterMeta } from "./telemetry.store";
import { formatLabel } from "./formatters";
import {
  recordingService,
  type LocalRecordingSummary,
} from "$lib/monitoring/recording-service";

// UI status
export type RecordingStatus = "idle" | "recording";
export const suiteRecordingStatus = writable<RecordingStatus>("idle");

// For UI timer (epoch ms). Null when not recording.
export const suiteRecordingStartedAtTs = writable<number | null>(null);

// Local recordings list (UI)
export const localRecordings = writable<LocalRecordingSummary[]>([]);
export const localRecordingsLoading = writable(false);
export const localRecordingsError = writable<string | null>(null);

export async function refreshLocalRecordings(): Promise<void> {
  localRecordingsLoading.set(true);
  localRecordingsError.set(null);

  try {
    localRecordings.set(await recordingService.listLocal());
  } catch (err: any) {
    localRecordingsError.set(err?.message ?? "Failed to load local recordings");
  } finally {
    localRecordingsLoading.set(false);
  }
}

// POI
export type RecordingPoi = {
  ts: number;        // epoch ms
  isoLocal: string;  // local wall-clock ISO (no timezone)
  tSec: number;      // seconds since recording start
  label: string;     // user note or default
};

export const suiteRecordingPoiCount = writable<number>(0);

let pois: RecordingPoi[] = [];
let poiDraft: Omit<RecordingPoi, "label"> | null = null;

// Session buffers
type Frame = {
  ts: number;
  values: Record<string, number>;
};
let frames: Frame[] = [];
let startedAtTs: number | null = null;
let lastDeviceId: string | null = null;
let startedAtIso: string | null = null;

// Snapshot identity at start to avoid drift mid-recording
let recordingVehicleName: string | null = null;
let recordingVin: string | null = null;

// Prebuffer for short history at record start
const PREBUFFER_MS = 10_000;
let preFrames: Frame[] = [];
let preLastDeviceId: string | null = null;

// Save dialog state (drives UI)
export type RecordingSaveDialogState =
  | { open: false }
  | {
      open: true;
      suggestedName: string;
      currentName: string;
      isSaving: boolean;
      error: string | null;
    };

export const recordingSaveDialog = writable<RecordingSaveDialogState>({ open: false });

function resetPoiState() {
  pois = [];
  poiDraft = null;
  suiteRecordingPoiCount.set(0);
}

function localIsoFromTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function buildPoiBase(ts: number): Omit<RecordingPoi, "label"> | null {
  if (!startedAtTs) return null;

  const tSec = (ts - startedAtTs) / 1000;
  return {
    ts,
    isoLocal: localIsoFromTs(ts),
    tSec: Number(tSec.toFixed(3)),
  };
}

export function beginPointOfInterestDraft(): Omit<RecordingPoi, "label"> | null {
  if (get(suiteRecordingStatus) !== "recording") return null;
  if (!startedAtTs) return null;

  if (poiDraft) return poiDraft;

  const base = buildPoiBase(Date.now());
  if (!base) return null;

  poiDraft = base;
  return poiDraft;
}

export function commitPointOfInterestDraft(label?: string): boolean {
  if (get(suiteRecordingStatus) !== "recording") return false;
  if (!startedAtTs || !poiDraft) return false;

  const cleaned = (label ?? "").trim();
  const finalLabel = cleaned || "Point of interest";

  pois.push({ ...poiDraft, label: finalLabel });
  poiDraft = null;
  suiteRecordingPoiCount.set(pois.length);
  return true;
}

export function cancelPointOfInterestDraft() {
  poiDraft = null;
}

// Backwards compatible one-shot POI
export function addPointOfInterest(label?: string) {
  if (get(suiteRecordingStatus) !== "recording") return;

  const base = buildPoiBase(Date.now());
  if (!base) return;

  const cleaned = (label ?? "").trim();
  const finalLabel = cleaned || "Point of interest";

  pois.push({ ...base, label: finalLabel });
  suiteRecordingPoiCount.set(pois.length);
}

function trimPreBuffer(now: number) {
  const cut = now - PREBUFFER_MS;
  while (preFrames.length > 0 && preFrames[0].ts < cut) preFrames.shift();
}

function localStampCompact() {
  const d = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

function sanitizeFileId(input: string): string {
  return input
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\.\.+/g, ".")
    .trim()
    .replace(/\s+/g, "_");
}

async function listExistingIds(): Promise<Set<string>> {
  return await recordingService.getAllLocalIds();
}

function incrementName(base: string, n: number): string {
  return n <= 1 ? base : `${base}_${n}`;
}

async function ensureUniqueId(desired: string): Promise<string> {
  const cleanedBase = sanitizeFileId(desired);
  const existing = await listExistingIds();

  if (!existing.has(cleanedBase)) return cleanedBase;

  let i = 2;
  while (existing.has(incrementName(cleanedBase, i))) i++;
  return incrementName(cleanedBase, i);
}

function buildDefaultName(): string {
  const namePart = (get(vehicleName) ?? "").trim() || "Vehicle";
  const vinPart = (get(vehicleVin) ?? "").trim() || "VIN";
  const base = `${namePart}__${vinPart}__${localStampCompact()}`;
  return sanitizeFileId(base).slice(0, 80);
}

function keyToPrettyName(key: string, metaMap: Record<string, any>): string {
  const m = metaMap[key];
  const raw =
    typeof m?.name === "string" && m.name.trim()
      ? m.name.trim()
      : key.replace(/[#/\\]+/g, " ").replace(/\s+/g, " ").trim();

  return formatLabel(raw);
}

function keyToUnit(key: string, metaMap: Record<string, any>): string {
  const m = metaMap[key];
  return typeof m?.unit === "string" && m.unit.trim() ? m.unit.trim() : "";
}

function makeUnique(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const c = (seen.get(n) ?? 0) + 1;
    seen.set(n, c);
    return c === 1 ? n : `${n} (${c})`;
  });
}

function resetSessionState(): void {
  frames = [];
  startedAtTs = null;
  lastDeviceId = null;
  startedAtIso = null;

  recordingVehicleName = null;
  recordingVin = null;

  resetPoiState();
  suiteRecordingStartedAtTs.set(null);
}

export function startSuiteRecording() {
  const now = Date.now();
  const deviceId = get(selectedDeviceId) ?? null;

  resetPoiState();

  if (preLastDeviceId !== deviceId) {
    preFrames = [];
    preLastDeviceId = deviceId;
  }

  trimPreBuffer(now);

  frames = preFrames.length > 0 ? [...preFrames] : [];
  startedAtTs = frames.length > 0 ? frames[0].ts : now;

  startedAtIso = new Date().toISOString();
  lastDeviceId = deviceId;

  recordingVehicleName = get(vehicleName);
  recordingVin = get(vehicleVin);

  suiteRecordingStartedAtTs.set(startedAtTs);
  suiteRecordingStatus.set("recording");
  recordingSaveDialog.set({ open: false });
}

export function pushFrameForRecording(
  values: Record<string, number>
) {
  const now = Date.now();
  const deviceId = get(selectedDeviceId) ?? null;
  const frame: Frame = { ts: now, values };

  if (preLastDeviceId !== deviceId) {
    preFrames = [];
    preLastDeviceId = deviceId;
  }

  preFrames.push(frame);
  trimPreBuffer(now);

  if (get(suiteRecordingStatus) !== "recording") return;
  if (!startedAtTs) return;

  frames.push(frame);
}

export async function stopSuiteRecording() {
  if (get(suiteRecordingStatus) !== "recording") return;

  suiteRecordingStatus.set("idle");
  suiteRecordingStartedAtTs.set(null);
  poiDraft = null;

  const suggestedName = buildDefaultName();
  recordingSaveDialog.set({
    open: true,
    suggestedName,
    currentName: suggestedName,
    isSaving: false,
    error: null,
  });
}

export async function confirmSaveRecording() {
  const state = get(recordingSaveDialog);
  if (!state.open) return;

  if (!startedAtTs || frames.length === 0) {
    recordingSaveDialog.set({ open: false });
    resetSessionState();
    return;
  }

  recordingSaveDialog.set({ ...state, isSaving: true, error: null });

  try {
    const rawName = (state.currentName || state.suggestedName || "").trim();
    const displayName = rawName || state.suggestedName;

    const id = await ensureUniqueId(displayName);

    const deviceId = lastDeviceId;
    const vehName = recordingVehicleName;
    const vin = recordingVin;

    const keys = Array.from(
      frames.reduce((set, f) => {
        Object.keys(f.values).forEach((k) => set.add(k));
        return set;
      }, new Set<string>())
    );

    const metaMap = get(parameterMeta) ?? {};
    const sep = ";";
    const prettyNames = makeUnique(keys.map((k) => keyToPrettyName(k, metaMap)));
    const unitRowValues = keys.map((k) => keyToUnit(k, metaMap));
    const recordingParameterMeta = Object.fromEntries(
      keys.map((key, index) => {
        const meta = metaMap[key];
        const columnName = prettyNames[index] ?? key;
        return [
          columnName,
          {
            key,
            name: meta?.name ?? keyToPrettyName(key, metaMap),
            unit: meta?.unit ?? "",
            module: meta?.module ?? "",
          },
        ];
      }),
    );

    const csvRows: string[] = [
      ["Time", ...prettyNames].join(sep) + sep,
      ["s", ...unitRowValues].join(sep) + sep,
    ];

    for (const f of frames) {
      const tSec = ((f.ts - startedAtTs) / 1000).toFixed(3);

      csvRows.push(
        [
          tSec,
          ...keys.map((k) => (Number.isFinite(f.values[k]) ? String(f.values[k]) : "")),
        ]
          .join(sep) + sep
      );
    }

    const savedAtIso = new Date().toISOString();

    const metadataObj = {
      id,
      name: displayName,
      deviceId,
      source: "suite",
      time: startedAtIso ?? new Date().toISOString(),
      savedAtIso,
      vehicleName: vehName ?? null,
      vin: vin ?? null,
      parameterMeta: recordingParameterMeta,
      pois: pois.map((p) => ({
        tSec: p.tSec,
        isoLocal: p.isoLocal,
        label: p.label,
      })),
    };

    const metadataJson = JSON.stringify(metadataObj, null, 2);
    const csvText = csvRows.join("\n");

    const savedSummary = await recordingService.saveLocal({
      id,
      name: displayName,
      deviceId: deviceId ?? null,
      vin: vin ?? null,
      vehicleName: vehName ?? null,
      createdAtIso: startedAtIso ?? new Date().toISOString(),
      savedAtIso,
      metadataJson,
      csvText,
    });

    localRecordings.update((items) => {
      if (items.some((x) => x.id === savedSummary.id)) return items;
      return [savedSummary, ...items];
    });

    recordingSaveDialog.set({ open: false });
    resetSessionState();
  } catch (err: any) {
    recordingSaveDialog.set({
      ...state,
      isSaving: false,
      error: err?.message ?? "Failed to save recording",
    });
  }
}

export function cancelSaveRecording() {
  recordingSaveDialog.set({ open: false });
  resetSessionState();
}

export function setRecordingFileName(name: string) {
  const state = get(recordingSaveDialog);
  if (!state.open) return;
  recordingSaveDialog.set({ ...state, currentName: name, error: null });
}
