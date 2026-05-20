<script lang="ts">
  import CalibrationMapsPanel from "../../../components/monitoring/CalibrationMapsPanel.svelte";
</script>

<svelte:head>
  <title>Calibration Maps</title>
</svelte:head>

<div class="h-[90vh] w-[95vw] overflow-hidden flex flex-col">
  <div
    class="flex-1 min-h-0 border border-slate-300 dark:border-white/10 dark:bg-slate-300/5 rounded-[10px] overflow-hidden p-3"
  >
    <CalibrationMapsPanel />
  </div>
</div>
