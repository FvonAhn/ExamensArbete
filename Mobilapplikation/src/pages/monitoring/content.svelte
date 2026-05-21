<script lang="ts">
  import { onDestroy } from 'svelte';

  import BroadcastButton from './broadcast-button.svelte';
  import InviteButton from './invite-button.svelte';
  import LiveValues from './live-values.svelte';
  import BroadcastStatusDialog from './broadcast-status-dialog.svelte';
  import { createBroadcastOverlayController } from './broadcast-overlay-controller';
  import { broadcastConnectionState } from '../../utils/telemetry/telemetry-sender';
  import {
    cancelMonitoringResumeAfterBleReconnect,
    isMonitoring,
    stopMonitoring,
  } from '../../utils/telemetry/telemetry-broadcast';

  export let logValues: any[] = [];

  const broadcastOverlayController = createBroadcastOverlayController();
  const showBroadcastDisconnectedOverlay = broadcastOverlayController.interruptedVisible;
  const showBroadcastReconnectedOverlay = broadcastOverlayController.restoredVisible;

  $: broadcastOverlayController.handleConnectionState(
    $isMonitoring,
    $broadcastConnectionState,
  );

  export async function stopBroadcastSession(): Promise<void> {
    cancelMonitoringResumeAfterBleReconnect();

    if ($isMonitoring) {
      await stopMonitoring();
    }
  }

  onDestroy(() => {
    broadcastOverlayController.reset();
    void stopBroadcastSession();
  });
</script>

<div class="live-telemetry-broadcast-page">
  <BroadcastStatusDialog
    mode="interrupted"
    open={$showBroadcastDisconnectedOverlay}
    on:close={() => broadcastOverlayController.dismissInterrupted()}
  />

  <BroadcastStatusDialog
    mode="restored"
    open={$showBroadcastReconnectedOverlay}
    autoCloseMs={1500}
    on:close={() => broadcastOverlayController.dismissRestored()}
  />

  <div class="live-telemetry-broadcast-page__actions">
    <InviteButton />
    <BroadcastButton />
  </div>

  <LiveValues {logValues} />
</div>
