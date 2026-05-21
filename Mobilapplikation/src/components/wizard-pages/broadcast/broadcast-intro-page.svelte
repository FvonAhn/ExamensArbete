<script lang="ts">
  import { activeWizardPage, wizardPushPage } from "../../../stores/dialogs";
  import { StaticWizardPages } from "../../../utils/constants";

  import WizardButton from "../utils/wizard-button.svelte";
  import BroadcastIcon from "../../../icons/control-broadcast.svelte";

  export let startPage: string;
  export let invitePage: string;
  export let cancelPage: string = StaticWizardPages.CLOSE;

  const btnEnabledColorRed =
    "bg-gradient-to-t from-button-no-bottom to-button-no-top";
  const btnEnabledColor =
    "bg-gradient-to-t from-button-enabled-bottom to-button-enabled-top";

  $: context = $activeWizardPage.context ?? {};

  const startBtnEnabled = true;

  function onStart(): void {
    if (!startBtnEnabled) return;
    wizardPushPage(startPage, context);
  }

  function onInvite(): void {
    wizardPushPage(invitePage, context);
  }

  function onClose(): void {
    wizardPushPage(cancelPage);
  }
</script>

<div class="flex flex-col h-full">
  <div class="flex-1 min-h-0 overflow-auto flex flex-col gap-6 pt-8 items-center px-4">
    <p class="font-bold text-lg text-center">Live telemetry broadcast</p>

    <p class="text-sm opacity-90 text-center max-w-md">
      Broadcast lets other users view your live telemetry in real time.
    </p>

    <p class="text-sm opacity-90 text-center max-w-md">
      You can optionally invite a user by email before starting.
    </p>
  </div>

  <div class="flex justify-center pb-8">
    <button
      type="button"
      on:click={onStart}
      class="flex w-44 h-44 rounded-full bg-gradient-to-t from-button-enabled-bottom to-button-enabled-top items-center justify-center {startBtnEnabled ? '' : 'brightness-50'}"
      aria-label="Start broadcast"
      disabled={!startBtnEnabled}
      aria-disabled={!startBtnEnabled}
    >
      <div
        class="flex bg-gradient-to-t from-button-enabled-top to-button-enabled-bottom h-36 w-36 rounded-full text-white font-bold text-2xl tracking-widest justify-center items-center"
      >
        <span class="w-20 h-20 flex items-center justify-center icon-20">
          <BroadcastIcon />
        </span>
      </div>
    </button>
  </div>

  <div class="flex justify-center gap-4 py-4">
    <WizardButton btnColor={btnEnabledColorRed} onClick={onClose} btnText="Close" />
    <WizardButton btnColor={btnEnabledColor} onClick={onInvite} btnText="Invite" />
  </div>
</div>

<style>
  :global(.icon-20 svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
</style>