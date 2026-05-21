import { writable } from 'svelte/store';
import type { BroadcastConnectionState } from '../../utils/telemetry/telemetry-sender';

function isDownState(state: BroadcastConnectionState): boolean {
  return state === 'reconnecting' || state === 'disconnected';
}

export function createBroadcastOverlayController() {
  const interruptedVisible = writable(false);
  const restoredVisible = writable(false);

  let previousConnectionState: BroadcastConnectionState = 'idle';
  let interruptedDismissed = false;
  let interruptionActive = false;

  function handleConnectionState(
    isMonitoring: boolean,
    connectionState: BroadcastConnectionState,
  ): void {
    const wasDown = isDownState(previousConnectionState);
    const isDown = isDownState(connectionState);

    if (!isMonitoring) {
      interruptionActive = false;
      interruptedDismissed = false;
      interruptedVisible.set(false);
      restoredVisible.set(false);
      previousConnectionState = connectionState;
      return;
    }

    if (isDown && !interruptionActive) {
      interruptionActive = true;
    }

    interruptedVisible.set(interruptionActive && !interruptedDismissed);

    if (interruptionActive && !isDown && connectionState === 'connected') {
      interruptionActive = false;
      interruptedDismissed = false;
      interruptedVisible.set(false);
      restoredVisible.set(true);
    }

    previousConnectionState = connectionState;
  }

  function dismissInterrupted(): void {
    interruptedDismissed = true;
    interruptedVisible.set(false);
  }

  function dismissRestored(): void {
    restoredVisible.set(false);
  }

  function reset(): void {
    interruptionActive = false;
    interruptedDismissed = false;
    previousConnectionState = 'idle';
    interruptedVisible.set(false);
    restoredVisible.set(false);
  }

  return {
    interruptedVisible,
    restoredVisible,
    handleConnectionState,
    dismissInterrupted,
    dismissRestored,
    reset,
  };
}
