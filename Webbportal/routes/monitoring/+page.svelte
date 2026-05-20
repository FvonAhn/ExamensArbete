<script lang="ts">
  import type { PageData } from "./$types";

  import MonitoringPage from "../../components/monitoring/TelemetryDashboard.svelte";
  import { headerTitle } from "../../stores/header";
  import { headerText } from "../../stores/header";

  import { resolveDeviceDisplayName } from "../manageDevices/deviceNames.local";

  type DeviceDto = {
    maptunerId: string;
    isShared: boolean;
    name: string;
    userEmail: string;
  };

  type DeviceItem = {
    id: string;
    name: string;
    isShared: boolean;
  };

  type CustomPageData = PageData & {
    accessToken: string; // "Bearer …"
    telemetryToken: string; // raw token for SignalR
    devices: DeviceDto[];
  };

  export let data: CustomPageData;

  headerTitle.set("Live monitoring");
  headerText.set("View live telemetry data from Maptuner App");

  let myDevices: DeviceItem[] = [];
  let sharedDevices: DeviceItem[] = [];
  let errorMessage = "";

  const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  function toItem(d: DeviceDto): DeviceItem | null {
    const id = clean(d?.maptunerId);
    if (!id) return null;

    const backendName = clean(d?.name) || id;
    const name = resolveDeviceDisplayName(id, backendName);

    return { id, name, isShared: !!d?.isShared };
  }

  function uniqueById(items: DeviceItem[]): DeviceItem[] {
    const seen = new Set<string>();
    const out: DeviceItem[] = [];

    for (const it of items) {
      const id = clean(it?.id);
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(it);
    }

    return out;
  }

  function buildLists(): void {
    errorMessage = "";

    try {
      const accessToken = clean(data?.accessToken);
      if (!accessToken || accessToken.length < 10) throw new Error("Missing access token.");

      const devices = (data?.devices ?? []) as DeviceDto[];
      const items = devices.map(toItem).filter((x): x is DeviceItem => !!x);

      // Dedupe within each list
      const my = uniqueById(items.filter((d) => !d.isShared));

      // Ensure a device never appears in both lists (my wins)
      const myIds = new Set(my.map((d) => d.id));
      const shared = uniqueById(items.filter((d) => d.isShared)).filter((d) => !myIds.has(d.id));

      myDevices = my;
      sharedDevices = shared;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : "Failed to load devices.";
      myDevices = [];
      sharedDevices = [];
    }
  }

  buildLists();

  // Keep lists in sync if data changes (navigation, refresh, etc)
  $: data?.devices, buildLists();
</script>

<svelte:head>
  <title>Live Monitoring</title>
  <meta name="liveMonitoring" content="Live Monitoring" />
</svelte:head>

<MonitoringPage telemetryToken={data.telemetryToken} {myDevices} {sharedDevices} />

{#if errorMessage}
  <div class="px-4 py-2 text-rose-700 dark:text-rose-200 text-sm">Failed to load devices: {errorMessage}</div>
{/if}
