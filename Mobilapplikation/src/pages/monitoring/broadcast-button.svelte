<script lang="ts">
  import { Dialog } from "@capacitor/dialog";
  import ButtonRound from "../../components/button-round.svelte";
  import StopIcon from "../../icons/control-stop.svelte";
  import BroadcastIcon from "../../icons/control-broadcast.svelte";

  import { isMonitoring, stopMonitoring } from "../../utils/telemetry/telemetry-broadcast";
  import { startMonitoring } from "../../utils/telemetry/telemetry-broadcast";
  import { broadcastConnectionState } from "../../utils/telemetry/telemetry-sender";
  import { logWithTag } from "../../stores/diagnostics";

  $: monitoring = $isMonitoring;
  $: isReconnecting = $broadcastConnectionState === "reconnecting";
  let busy = false;

  async function onStartClick() {
    if (busy) return;

    busy = true;
    try {
      await logWithTag("internal", "broadcastButton;startClick");
      await startMonitoring();
      await logWithTag("internal", "broadcastButton;startResolved");
    } catch (error) {
      await logWithTag("internal", `broadcastButton;startError;${String(error)}`);
      await Dialog.alert({
        title: "Broadcast",
        message:
          error instanceof Error && error.message
            ? error.message
            : "Failed to start broadcast.",
      });
    } finally {
      busy = false;
      await logWithTag("internal", "broadcastButton;startFinally");
    }
  }

  async function onStopClick() {
    if (busy) return;

    busy = true;
    try {
      await logWithTag("internal", "broadcastButton;stopClick");
      await stopMonitoring();
      await logWithTag("internal", "broadcastButton;stopResolved");
    } catch (error) {
      await logWithTag("internal", `broadcastButton;stopError;${String(error)}`);
      await Dialog.alert({
        title: "Broadcast",
        message:
          error instanceof Error && error.message
            ? error.message
            : "Failed to stop broadcast.",
      });
    } finally {
      busy = false;
      await logWithTag("internal", "broadcastButton;stopFinally");
    }
  }
</script>

{#if !monitoring}
  <ButtonRound
    enabled={!busy}
    onClick={onStartClick}
    name={busy ? "Starting..." : "Broadcast"}
    icon={BroadcastIcon}
    bgColor="info-bg"
  />
{:else}
  <ButtonRound
    enabled={!busy}
    onClick={onStopClick}
    name={busy ? "Stopping..." : isReconnecting ? "Reconnecting..." : "Stop cast"}
    icon={StopIcon}
    bgColor="info-bg"
    pulse={!busy}
    truncateLabel={isReconnecting || busy}
  />
{/if}
