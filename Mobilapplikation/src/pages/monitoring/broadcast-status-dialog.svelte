<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { scale } from 'svelte/transition';

  export type BroadcastStatusMode = 'interrupted' | 'restored';

  export let mode: BroadcastStatusMode = 'interrupted';
  export let open = false;
  export let dismissable = true;
  export let autoCloseMs: number | null = null;

  const dispatch = createEventDispatcher<{ close: void }>();

  let autoCloseTimeout: ReturnType<typeof setTimeout> | null = null;

  $: title = mode === 'interrupted' ? 'Broadcast interrupted' : 'Connection restored';
  $:
    subtitle =
      mode === 'interrupted'
        ? 'Connection dropped. Trying to restore the broadcast link...'
        : 'Broadcasting resumed';

  function closeDialog(): void {
    dispatch('close');
  }

  function clearAutoClose(): void {
    if (autoCloseTimeout) {
      clearTimeout(autoCloseTimeout);
      autoCloseTimeout = null;
    }
  }

  $: {
    clearAutoClose();
    if (open && autoCloseMs && autoCloseMs > 0) {
      autoCloseTimeout = setTimeout(() => {
        closeDialog();
        autoCloseTimeout = null;
      }, autoCloseMs);
    }
  }

  function onBackdropClick(event: MouseEvent): void {
    if (!dismissable) {
      return;
    }

    if (event.target === event.currentTarget) {
      closeDialog();
    }
  }

  onDestroy(() => {
    clearAutoClose();
  });
</script>

{#if open}
  <div
    class="broadcast-overlay"
    on:click={onBackdropClick}
    on:keydown={(event) => {
      if (dismissable && (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        closeDialog();
      }
    }}
    role="button"
    tabindex="0"
    aria-label="Close broadcast status dialog"
  >
    <div
      class="broadcast-status-card"
      transition:scale={{ duration: 180, start: 0.95 }}
      role="dialog"
      aria-live="polite"
      aria-label={title}
    >
      <p class="broadcast-status-title">{title}</p>
      <p class="broadcast-status-subtitle">{subtitle}</p>

      {#if mode === 'interrupted'}
        <div class="broadcast-status-connection-stack">
          <div class="broadcast-status-reconnect-pill">
            <span class="broadcast-status-spinner" />
            <span>Reconnecting...</span>
          </div>
        </div>

        <p class="broadcast-status-footnote">Data transmission to viewers is paused</p>
      {:else}
        <div class="broadcast-status-restored-icon-area">
          <div class="broadcast-status-icon-wrap broadcast-status-icon-wrap--restored">
            <svg viewBox="0 0 120 120" class="broadcast-status-icon" aria-hidden="true">
              <circle
                cx="60"
                cy="60"
                r="46"
                fill="none"
                stroke="currentColor"
                stroke-width="7"
              />
              <path
                d="M39 62l15 15 28-28"
                fill="none"
                stroke="currentColor"
                stroke-width="8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .broadcast-overlay {
    position: absolute;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding: 0 0.75rem calc(env(safe-area-inset-bottom, 0px) + 0.7rem);
    background: linear-gradient(180deg, rgba(0, 0, 0, 0) 35%, rgba(0, 0, 0, 0.38) 100%);
    pointer-events: auto;
  }

  .broadcast-status-card {
    width: min(100%, 340px);
    min-height: 0;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(10, 14, 18, 0.9);
    backdrop-filter: blur(10px);
    color: #ffffff;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 0.72rem 0.82rem 0.68rem;
    box-shadow: 0 14px 32px rgba(0, 0, 0, 0.35);
    font-family: inherit;
  }

  .broadcast-status-title {
    margin: 0;
    font-size: 0.92rem;
    font-weight: 700;
    line-height: 1.25;
    letter-spacing: 0.01em;
  }

  .broadcast-status-subtitle {
    margin: 0.22rem 0 0;
    font-size: 0.76rem;
    line-height: 1.3;
    font-weight: 500;
    color: rgba(225, 232, 240, 0.74);
    max-width: 100%;
  }

  .broadcast-status-connection-stack {
    width: 100%;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    margin: 0.5rem 0 0;
  }

  .broadcast-status-reconnect-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.48rem;
    min-height: 34px;
    padding: 0.45rem 0.7rem;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .broadcast-status-restored-icon-area {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 54px;
    margin-top: 0.45rem;
  }

  .broadcast-status-icon-wrap--restored {
    margin: 0;
  }

  .broadcast-status-icon-wrap--restored .broadcast-status-icon {
    width: 44px;
    height: 44px;
  }

  .broadcast-status-reconnect-row {
    display: flex;
    align-items: center;
    font-size: 0.88rem;
    font-weight: 700;
  }

  .broadcast-status-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.24);
    border-top-color: rgba(255, 255, 255, 0.92);
    border-radius: 999px;
    animation: broadcastSpin 1.1s ease-in-out infinite;
    flex-shrink: 0;
  }

  .broadcast-status-footnote {
    margin: 0.4rem 0 0;
    font-size: 0.66rem;
    line-height: 1.3;
    font-weight: 500;
    color: rgba(225, 232, 240, 0.58);
  }

  @keyframes broadcastSpin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 768px) {
    .broadcast-status-card {
      width: min(100%, 320px);
      border-radius: 14px;
      padding: 0.68rem 0.78rem 0.64rem;
    }

    .broadcast-status-title {
      font-size: 0.88rem;
    }

    .broadcast-status-subtitle {
      font-size: 0.74rem;
      margin-top: 0.2rem;
    }

    .broadcast-status-connection-stack {
      margin-top: 0.45rem;
    }

    .broadcast-status-reconnect-pill {
      min-height: 32px;
      padding: 0.4rem 0.62rem;
    }

    .broadcast-status-icon-wrap--restored .broadcast-status-icon {
      width: 38px;
      height: 38px;
    }

    .broadcast-status-reconnect-row {
      font-size: 0.84rem;
    }

    .broadcast-status-footnote {
      margin-top: 0.36rem;
      font-size: 0.64rem;
    }
  }
</style>
