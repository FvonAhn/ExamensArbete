<script lang="ts">
  import { onDestroy } from 'svelte';

  import {
    handleLogsChangedForBroadcast,
    resetMonitoringState,
  } from '../../utils/telemetry/telemetry-broadcast';

  export let logValues: any[] = [];

  let lastBroadcastedValues: any[] | null = null;

  $: if (logValues !== lastBroadcastedValues) {
    lastBroadcastedValues = logValues;
    void handleLogsChangedForBroadcast(logValues);
  }

  onDestroy(() => {
    resetMonitoringState();
  });
</script>

<slot />
