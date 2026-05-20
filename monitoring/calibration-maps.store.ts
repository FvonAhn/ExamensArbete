import { writable } from "svelte/store";
import type { Bin, Map, MapEditorProject } from "../../utils/types";
import {
  flattenProjects,
  normalizeErrorMessage,
  normalizeVin,
  type ProjectOption,
} from "./calibration-maps.utils";

export type CalibrationMapsState = {
  loadingBins: boolean;
  loadingVehicles: boolean;
  loadingProject: boolean;
  errorMessage: string;
  currentVin: string;
  availableVehicles: string[];
  projectOptions: ProjectOption[];
  project: MapEditorProject | null;
  selectedProjectValue: string;
  selectedMapValue: string;
  selectedProjectOption: ProjectOption | null;
  selectedMap: Map | null;
  loadedProjectId: number | null;
};

const initialState: CalibrationMapsState = {
  loadingBins: false,
  loadingVehicles: false,
  loadingProject: false,
  errorMessage: "",
  currentVin: "",
  availableVehicles: [],
  projectOptions: [],
  project: null,
  selectedProjectValue: "",
  selectedMapValue: "",
  selectedProjectOption: null,
  selectedMap: null,
  loadedProjectId: null,
};

function deriveState(state: CalibrationMapsState): CalibrationMapsState {
  const selectedProjectOption = state.selectedProjectValue
    ? state.projectOptions.find((item) => String(item.id) === state.selectedProjectValue) ?? null
    : null;
  const selectedMap =
    state.project && state.selectedMapValue
      ? state.project.maps.find((map) => String(map.id) === state.selectedMapValue) ?? null
      : null;

  return {
    ...state,
    selectedProjectOption,
    selectedMap,
  };
}

function resolveProjectSelection(projectOptions: ProjectOption[], preferredValue?: string) {
  if (preferredValue && projectOptions.some((item) => String(item.id) === preferredValue)) {
    return preferredValue;
  }

  return projectOptions.length > 0 ? String(projectOptions[0].id) : "";
}

function resolveMapSelection(project: MapEditorProject | null, selectedMapValue: string) {
  if (!project?.maps?.length) {
    return "";
  }

  if (selectedMapValue && project.maps.some((map) => String(map.id) === selectedMapValue)) {
    return selectedMapValue;
  }

  return String(project.maps[0].id);
}

async function readErrorMessage(response: Response, fallback: string) {
  const errorData = await response.json().catch(() => ({ message: fallback }));
  return normalizeErrorMessage(errorData?.error || errorData?.message, fallback);
}

export function createCalibrationMapsStore() {
  const { subscribe, set } = writable<CalibrationMapsState>(initialState);

  let state = initialState;
  let cachedVehicleCatalog: string[] | null = null;
  const cachedBinsByVin = new Map<string, Bin[]>();
  const cachedProjectsById = new Map<number, MapEditorProject>();
  // Request ids let us ignore late responses when the user switches VIN/project quickly.
  let binsRequestId = 0;
  let projectRequestId = 0;

  function commit(next: CalibrationMapsState) {
    state = deriveState(next);
    set(state);
  }

  function patch(mutator: (current: CalibrationMapsState) => CalibrationMapsState) {
    commit(mutator(state));
  }

  function applyProjectOptions(vin: string, projectOptions: ProjectOption[], preferredProjectValue?: string) {
    patch((current) => ({
      ...current,
      currentVin: vin,
      projectOptions,
      selectedProjectValue: resolveProjectSelection(projectOptions, preferredProjectValue),
    }));
  }

  async function loadVehicles() {
    patch((current) => ({
      ...current,
      loadingVehicles: true,
    }));

    try {
      if (cachedVehicleCatalog) {
        patch((current) => ({
          ...current,
          availableVehicles: cachedVehicleCatalog,
          loadingVehicles: false,
        }));
        return cachedVehicleCatalog;
      }

      const response = await fetch("/api/mapeditor/vehicles");
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "Failed to fetch vehicles"));
      }

      const data = await response.json();
      const availableVehicles = Array.isArray(data)
        ? data.map((value) => normalizeVin(typeof value === "string" ? value : "")).filter(Boolean)
        : [];

      cachedVehicleCatalog = availableVehicles;
      patch((current) => ({
        ...current,
        availableVehicles,
        loadingVehicles: false,
      }));

      return availableVehicles;
    } catch (error) {
      patch((current) => ({
        ...current,
        availableVehicles: [],
        loadingVehicles: false,
      }));
      throw new Error(normalizeErrorMessage(error, "Failed to fetch vehicles"));
    }
  }

  async function syncVehicleVin(vin: string, preferredProjectValue?: string, preferredMapValue?: string) {
    const normalizedVin = normalizeVin(vin);
    const requestId = ++binsRequestId;

    if (!normalizedVin) {
      commit(initialState);
      return;
    }

      patch((current) => ({
        ...current,
        errorMessage: "",
        currentVin: normalizedVin,
        projectOptions: [],
        project: null,
        selectedProjectValue: "",
        selectedMapValue: preferredMapValue ?? "",
        loadedProjectId: null,
      }));

    try {
      let availableVehicles = state.availableVehicles;
      if (availableVehicles.length === 0) {
        availableVehicles = await loadVehicles();
      }

      const hasMatchingVehicle = availableVehicles.some(
        (candidate) => candidate.localeCompare(normalizedVin, undefined, { sensitivity: "accent" }) === 0,
      );

      if (!hasMatchingVehicle || requestId !== binsRequestId) {
        return;
      }

      const cachedBins = cachedBinsByVin.get(normalizedVin);
      if (cachedBins) {
        applyProjectOptions(normalizedVin, flattenProjects(cachedBins), preferredProjectValue);
        return;
      }

      patch((current) => ({
        ...current,
        loadingBins: true,
      }));

      const response = await fetch(`/api/mapeditor/vehicles/${encodeURIComponent(normalizedVin)}/bins`);
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, `Failed to fetch bins (HTTP ${response.status})`));
      }

      const data = await response.json();
      if (requestId !== binsRequestId) return;

      const normalizedBins = Array.isArray(data) ? data : [];
      cachedBinsByVin.set(normalizedVin, normalizedBins);
      applyProjectOptions(normalizedVin, flattenProjects(normalizedBins), preferredProjectValue);
      patch((current) => ({
        ...current,
        loadingBins: false,
      }));
    } catch (error) {
      if (requestId !== binsRequestId) return;

      patch((current) => ({
        ...current,
        loadingBins: false,
        errorMessage: normalizeErrorMessage(error, "Failed to load Map Editor projects"),
      }));
    }
  }

  async function loadProject(projectId: number) {
    const requestId = ++projectRequestId;

    patch((current) => ({
      ...current,
      loadingProject: true,
      errorMessage: "",
    }));

    try {
      const cachedProject = cachedProjectsById.get(projectId);
      if (cachedProject) {
        if (requestId !== projectRequestId) return;

        patch((current) => ({
          ...current,
          project: cachedProject,
          loadedProjectId: cachedProject.id,
          selectedMapValue: resolveMapSelection(cachedProject, current.selectedMapValue),
          loadingProject: false,
        }));
        return;
      }

      const response = await fetch(`/api/mapeditor/projects/${projectId}`);
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, `Failed to fetch project (HTTP ${response.status})`));
      }

      const data = (await response.json()) as MapEditorProject;
      if (requestId !== projectRequestId) return;

      cachedProjectsById.set(projectId, data);
      patch((current) => ({
        ...current,
        project: data,
        loadedProjectId: data.id,
        selectedMapValue: resolveMapSelection(data, current.selectedMapValue),
        loadingProject: false,
      }));
    } catch (error) {
      if (requestId !== projectRequestId) return;

      patch((current) => ({
        ...current,
        project: null,
        loadedProjectId: null,
        selectedMapValue: "",
        loadingProject: false,
        errorMessage: normalizeErrorMessage(error, "Failed to load project"),
      }));
    }
  }

  return {
    subscribe,
    reset() {
      ++binsRequestId;
      ++projectRequestId;
      commit(initialState);
    },
    selectProjectValue(value: string) {
      patch((current) => ({
        ...current,
        selectedProjectValue: value,
      }));
    },
    selectMapValue(value: string) {
      patch((current) => ({
        ...current,
        selectedMapValue: value,
      }));
    },
    syncVehicleVin,
    loadProjectIfNeeded(projectId: number | null) {
      if (
        projectId == null ||
        !Number.isFinite(projectId) ||
        state.loadingBins ||
        state.loadingProject ||
        state.loadedProjectId === projectId
      ) {
        return;
      }

      void loadProject(projectId);
    },
  };
}
