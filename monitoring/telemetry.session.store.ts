import { writable } from "svelte/store";

function createSelectedDeviceIdStore() {
  const stored =
    typeof window !== "undefined"
      ? localStorage.getItem("suite.selectedDeviceId")
      : null;

  const { subscribe, set } = writable<string | null>(stored);

  return {
    subscribe,
    set: (value: string | null) => {
      set(value);
      if (typeof window !== "undefined") {
        if (value) localStorage.setItem("suite.selectedDeviceId", value);
        else localStorage.removeItem("suite.selectedDeviceId");
      }
    },
  };
}

export const selectedDeviceId = createSelectedDeviceIdStore();