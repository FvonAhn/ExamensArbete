<script lang="ts">
  import { onMount } from "svelte";
  import TelemetryData from "../../../components/monitoring/TelemetryData.svelte";

  const isBrowser = typeof window !== "undefined";
  let singleColumnTiles = false;

  onMount(() => {
    if (!isBrowser) return;
    const mq = window.matchMedia("(max-width: 960px)");
    singleColumnTiles = mq.matches;
    const update = () => (singleColumnTiles = mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  });
</script>

<svelte:head>
  <title>Telemetry Values</title>
</svelte:head>

<div class="h-[90vh] w-[95vw] overflow-hidden flex flex-col">
  <div
    id="telemetry-popout"
    class="flex-1 min-h-0 transition-all duration-100 custom-scrollbar overflow-y-auto [scrollbar-gutter:stable] rounded-[10px] border border-slate-300 bg-white/75 p-2 dark:border-white/10 dark:bg-slate-300/5"
  >
    <div class="h-full min-h-0 transition-all duration-100 origin-top">
      {#if isBrowser}
        <TelemetryData {singleColumnTiles} />
      {/if}
    </div>
  </div>
</div>
