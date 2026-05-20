<script lang="ts">
  import { FontAwesomeIcon } from "@fortawesome/svelte-fontawesome";
  import { faPause } from "@fortawesome/free-solid-svg-icons";
  import TelemetryChartPopout from "../../../components/monitoring/TelemetryChartPopout.svelte";
  import TelemetryChartSettings from "../../../components/monitoring/TelemetryChartSettings.svelte";
  import { chartSnapshot } from "$lib/popout/popout.chart.store";

  let chartPaused = false;

  function updateWindowSeconds(value: number) {
    if (typeof window === "undefined" || !window.opener) return;
    window.opener.postMessage({ type: "chart:set-window-seconds", value }, window.location.origin);
  }

  function updateTooltipOpacity(value: number) {
    if (typeof window === "undefined" || !window.opener) return;
    window.opener.postMessage({ type: "chart:set-tooltip-opacity", value }, window.location.origin);
  }
</script>

<svelte:head>
  <title>Unit Graph</title>
</svelte:head>

<div class="h-[90vh] w-[95vw] overflow-hidden">
  <div class="h-full w-full rounded-[10px] border border-slate-300 bg-white/75 overflow-hidden dark:border-white/10 dark:bg-slate-300/5">
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex shrink-0 items-center justify-end px-2 pt-2">
        <div class="flex items-center gap-2">
          {#if chartPaused}
            <span class="chart-paused-indicator" aria-label="Paused" title="Paused">
              <FontAwesomeIcon icon={faPause} />
            </span>
          {/if}
          <TelemetryChartSettings
            value={$chartSnapshot.windowSeconds ?? 10}
            tooltipOpacity={$chartSnapshot.tooltipOpacity ?? 0.9}
            on:change={(event) => updateWindowSeconds(event.detail.value)}
            on:tooltipOpacityChange={(event) => updateTooltipOpacity(event.detail.value)}
          />
        </div>
      </div>

      <div class="min-h-0 flex-1 p-2 pt-1">
        <TelemetryChartPopout on:freezechange={(event) => (chartPaused = event.detail.paused)} />
      </div>
    </div>
  </div>
</div>

<style>
  .chart-paused-indicator {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    color: rgb(100 116 139);
  }

  :global([data-theme="dark"]) .chart-paused-indicator {
    color: rgb(226 232 240 / 0.82);
  }
</style>
