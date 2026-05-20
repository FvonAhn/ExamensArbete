<script lang="ts">
  import LocationMap from "../../../components/monitoring/MonitoringMap.svelte";
</script>

<svelte:head>
  <title>Location Map</title>
</svelte:head>

<div class="h-[90vh] w-[95vw] overflow-hidden">
  <div class="h-full w-full rounded-[10px] border border-slate-300 bg-white/75 p-2 overflow-hidden dark:border-white/10 dark:bg-slate-300/5">
    <LocationMap />
  </div>
</div>
