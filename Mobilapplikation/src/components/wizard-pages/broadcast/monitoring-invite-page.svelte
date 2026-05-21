<script lang="ts">
  import { onMount } from "svelte";
  import { activeWizardPage, wizardPushPage } from "../../../stores/dialogs";
  import { StaticWizardPages } from "../../../utils/constants";
  import WizardButton from "../utils/wizard-button.svelte";

  import {
    sendMonitoringInvite,
    getMonitoringConnections,
    removeMonitoringConnection,
    getMyEmail,
    type MonitoringConnection,
  } from "../../../stores/monitoring-invites";

  export let backPage: string = StaticWizardPages.CLOSE;
  export let backText: string = "Back";

  const btnEnabledColorRed =
    "bg-gradient-to-t from-button-no-bottom to-button-no-top";
  const btnEnabledColor =
    "bg-gradient-to-t from-button-enabled-bottom to-button-enabled-top";
  const btnDisabledColor =
    "bg-gradient-to-t from-button-disabled-bottom to-button-disabled-top";

  $: context = $activeWizardPage.context ?? {};

  let inviteEmail = "";

  let sending = false;
  let removingId: number | null = null;

  let showSuccess = false;
  let successMessage = "Invitation sent to the recipient.";

  let showError = false;
  let errorMessage = "";

  let listLoading = false;
  let listError = "";
  let outgoingInvites: MonitoringConnection[] = [];

  let myEmail: string | null = null;

  const normalizeEmail = (v: string) => v.trim().toLowerCase();

  function isValidEmail(value: string): boolean {
    const v = value.trim();
    if (v.length < 3) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }

  $: inviteEnabled = !sending && isValidEmail(inviteEmail);

  function onBack(): void {
    wizardPushPage(backPage, context);
  }

  function clearFeedback(): void {
    showSuccess = false;
    showError = false;
    errorMessage = "";
  }

  function setError(msg: string) {
    showSuccess = false;
    showError = true;
    errorMessage = msg;
  }

  function setSuccess(msg: string) {
    showError = false;
    showSuccess = true;
    successMessage = msg;
  }

  async function loadMyEmailOnce(): Promise<string | null> {
    if (myEmail) return myEmail;
    myEmail = await getMyEmail();
    return myEmail;
  }

  async function refreshOutgoingInvites(): Promise<void> {
    listError = "";
    listLoading = true;

    try {
      const me = normalizeEmail((await loadMyEmailOnce()) ?? "");
      const all = await getMonitoringConnections();

      outgoingInvites = all
        .filter((x) => normalizeEmail(x.userEmail ?? "") === me)
        .sort((a, b) => b.id - a.id);
    } catch {
      listError = "Failed to load invites.";
      outgoingInvites = [];
    } finally {
      listLoading = false;
    }
  }

  async function doSendInvite(): Promise<void> {
    if (!inviteEnabled) return;

    clearFeedback();
    sending = true;

    try {
      await sendMonitoringInvite(inviteEmail.trim());

      inviteEmail = "";
      setSuccess("Invitation sent to the recipient.");

      await refreshOutgoingInvites();

      window.setTimeout(() => {
        showSuccess = false;
      }, 2500);
    } catch {
      setError("Failed to send invitation. Please try again.");
    } finally {
      sending = false;
    }
  }

  async function doRemoveInvite(id: number): Promise<void> {
    clearFeedback();
    removingId = id;

    try {
      await removeMonitoringConnection(id);
      await refreshOutgoingInvites();
    } catch {
      setError("Failed to remove invite. Please try again.");
    } finally {
      removingId = null;
    }
  }

  function onSendClick(): void {
    void doSendInvite();
  }

  onMount(() => {
    void refreshOutgoingInvites();
  });
</script>

<div class="flex flex-col h-full">
  <div class="flex-none pt-8 px-4 flex flex-col items-center gap-6">
    <p class="font-bold text-lg text-center">Invite a user</p>

    <p class="text-sm opacity-90 text-center max-w-md">
      Enter an email address to allow someone else to view your live telemetry.
    </p>

    <div class="w-full max-w-md">
      <div class="flex items-center justify-center gap-2">
        <label for="broadcast-invite-email" class="font-bold">Email:</label>

        <input
          id="broadcast-invite-email"
          class="text-mt-gray-dark text-center w-3/5 h-8 rounded-xl"
          type="email"
          inputmode="email"
          autocomplete="email"
          placeholder="name@example.com"
          bind:value={inviteEmail}
          on:input={clearFeedback}
        />
      </div>

      <p class="text-xs opacity-75 mt-3 text-center">
        The invitation must be accepted in the Suite before the user can view your live telemetry.
      </p>

      <div class="mt-3 min-h-[2.5rem] flex items-center justify-center">
        {#if showError}
          <p class="text-sm font-semibold text-red-200 text-center">
            {errorMessage}
          </p>
        {:else if showSuccess}
          <p class="text-sm font-semibold text-green-200 text-center">
            {successMessage}
          </p>
        {/if}
      </div>
    </div>
  </div>

  <div class="flex-1 min-h-0 px-4 mt-4">
    <div class="w-full max-w-md mx-auto h-full flex flex-col">
      <p class="font-bold text-center">Sent invites</p>

      <div class="flex-1 min-h-0 overflow-y-auto mt-4 pr-1">
        {#if listLoading}
          <p class="text-sm opacity-80 text-center">Loading invites...</p>

        {:else if listError}
          <p class="text-sm font-bold text-red-200 text-center">{listError}</p>

        {:else if outgoingInvites.length === 0}
          <div class="flex flex-col items-center justify-center text-center gap-2 mt-6 opacity-80">
            <p class="text-sm font-bold">No invites sent yet</p>
            <p class="text-sm max-w-xs">
              Enter an email address above and press <span class="font-semibold">Send</span>
              to invite someone to view your live telemetry.
            </p>
          </div>

        {:else}
          <div class="flex flex-col gap-2">
            {#each outgoingInvites as inv (inv.id)}
              {@const statusText =
                inv.status === 0
                  ? "Pending"
                  : inv.status === 1
                  ? "Accepted"
                  : `Status ${inv.status}`}

              {@const statusClass =
                inv.status === 0
                  ? "text-yellow-300"
                  : inv.status === 1
                  ? "text-green-300"
                  : "text-gray-300"}

              <div class="flex items-center justify-between rounded-xl px-3 py-2 bg-black/20">
                <div class="min-w-0">
                  <p class="text-sm font-bold truncate">
                    {normalizeEmail(inv.invitedUserEmail ?? "")}
                  </p>

                  <p class={`text-xs font-semibold ${statusClass}`}>
                    {statusText}
                  </p>
                </div>

                <button
                  type="button"
                  class="text-sm underline opacity-90"
                  on:click={() => void doRemoveInvite(inv.id)}
                  disabled={sending || removingId !== null}
                  aria-busy={removingId === inv.id}
                >
                  {removingId === inv.id ? "Removing..." : "Remove"}
                </button>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>

  <div class="flex-none flex justify-center gap-4 py-4">
    <WizardButton btnColor={btnEnabledColorRed} onClick={onBack} btnText={backText} />

    <WizardButton
      btnColor={inviteEnabled ? btnEnabledColor : btnDisabledColor}
      onClick={onSendClick}
      btnText={sending ? "Sending..." : "Send"}
    />
  </div>
</div>
