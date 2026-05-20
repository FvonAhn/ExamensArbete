<script lang="ts">
  import { onMount } from "svelte";
  import TelemetryValueChartPopout from "../../../components/monitoring/TelemetryValueChartPopout.svelte";
  import { parameterMeta as popParameterMeta } from "$lib/popout/popout.telemetry.store";
  import { extractParamNameFromKey } from "$lib/monitoring/telemetry.logic";
  import { formatLabel } from "$lib/monitoring/formatters";
  import { FontAwesomeIcon } from "@fortawesome/svelte-fontawesome";
  import { faChevronLeft, faChevronRight } from "@fortawesome/free-solid-svg-icons";
  import type { ChartType } from "$lib/monitoring/telemetry.chartOptions";

  const isBrowser = typeof window !== "undefined";
  
  // Available chart types
  const chartTypes: ChartType[] = ["line", "gauge", "gauge-pressure"];
  const chartTypeNames: Record<ChartType, string> = {
    line: "Line",
    gauge: "Gauge",
    "gauge-pressure": "Pressure",
  };
  
  let valueKey: string | null = null;
  let chartTypeIndex: number = 0;
  const dashboardBtnClass =
    "inline-flex h-[32px] min-w-[32px] items-center justify-center rounded-[6px] " +
    "border border-slate-300 bg-white/75 text-slate-700 transition hover:bg-slate-200/70 " +
    "dark:border-white/10 dark:bg-slate-300/5 dark:text-slate-100 dark:hover:bg-white/10";

  onMount(() => {
    if (!isBrowser) return;

    // Get key from URL query parameter
    const params = new URLSearchParams(window.location.search);
    valueKey = params.get("key");

    // Listen for close request from opener (opener's w.close() can fail when
    // user gesture was in another window; self-close always works)
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === "value-popout:close") {
        window.close();
      }
    };
    window.addEventListener("message", handleMessage);
    const removeMessageListener = () => window.removeEventListener("message", handleMessage);

    // Request data from opener
    const requestData = () => {
      if (window.opener && valueKey) {
        try {
          // Try to check if opener is still valid
          const openerValid = !window.opener.closed;
          if (openerValid) {
            // Try with origin first, fallback to "*" if that fails
            try {
              window.opener.postMessage({ type: "telemetry-value:ready", key: valueKey }, window.location.origin);
            } catch (err) {
              // If origin fails, try with "*" (handles maximization issues)
              window.opener.postMessage({ type: "telemetry-value:ready", key: valueKey }, "*");
            }
          }
        } catch (err) {
          console.warn("[TelemetryValue] Failed to send ready message to opener", err);
        }
      }
    };

    requestData();

    // Re-request data periodically and when window gains focus (handles maximization)
    const requestInterval = setInterval(requestData, 2000); // Request every 2 seconds
    
    window.addEventListener("focus", requestData);
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        requestData();
      }
    };
    window.addEventListener("visibilitychange", handleVisibilityChange);

    // Cleanup
    return () => {
      clearInterval(requestInterval);
      window.removeEventListener("focus", requestData);
      window.removeEventListener("visibilitychange", handleVisibilityChange);
      removeMessageListener();
    };
  });

  $: meta = valueKey && $popParameterMeta ? $popParameterMeta[valueKey] : null;
  $: displayName = formatLabel(meta?.name ?? (valueKey ? extractParamNameFromKey(valueKey) : ""));
  $: currentChartType = chartTypes[chartTypeIndex];

  function nextChartType() {
    chartTypeIndex = (chartTypeIndex + 1) % chartTypes.length;
  }

  function prevChartType() {
    chartTypeIndex = (chartTypeIndex - 1 + chartTypes.length) % chartTypes.length;
  }
</script>

<svelte:head>
  <title>{displayName ? `${displayName} Graph` : "Value Graph"}</title>
</svelte:head>

<div class="h-[90vh] w-[95vw] overflow-hidden">
  <div class="h-full w-full rounded-[10px] border border-slate-300 bg-white/75 p-2 overflow-hidden dark:border-white/10 dark:bg-slate-300/5">
    <div class="flex h-full min-h-0 flex-col gap-2">
      <div class="flex shrink-0 flex-row items-center justify-between px-2 py-1">
        <h2 class="text-light-gray">{displayName}</h2>

        <div class="flex items-center gap-4">
        <button
          on:click={prevChartType}
          class={`${dashboardBtnClass} cursor-pointer px-3 py-1`}
          title="Previous chart type"
          aria-label="Previous chart type"
        >
          <FontAwesomeIcon icon={faChevronLeft} />
        </button>
        
        <span class="text-light-gray text-sm min-w-[80px] text-center">
          {chartTypeNames[currentChartType]}
        </span>

        <button
          on:click={nextChartType}
          class={`${dashboardBtnClass} cursor-pointer px-3 py-1`}
          title="Next chart type"
          aria-label="Next chart type"
        >
          <FontAwesomeIcon icon={faChevronRight} />
        </button>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-hidden rounded-[10px] border border-slate-300 bg-white/60 p-2 dark:border-white/10 dark:bg-slate-300/5">
        {#if isBrowser && valueKey}
          <TelemetryValueChartPopout {valueKey} chartType={currentChartType} />
        {:else if isBrowser}
          <div class="py-10 text-center text-2xl font-bold text-gray-400">
            Loading...
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>
