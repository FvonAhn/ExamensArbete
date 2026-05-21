<script lang="ts">
  import UserPlusIcon from "../../icons/user-plus.svelte";
  import { wizardStart } from "../../stores/dialogs";

  function onClick(): void {
    wizardStart({
      name: "monitoring-invite-wizard",
      context: {},
    });
  }
</script>

<button
  type="button"
  class="monitoring-invite-button"
  on:click={onClick}
  aria-label="Invite viewer"
>
  <span class="monitoring-invite-button__icon">
    <UserPlusIcon />
  </span>
  <span class="monitoring-invite-button__label">Invite</span>
</button>

<style>
  .monitoring-invite-button {
    @apply flex items-center justify-center gap-1 rounded-full text-sm font-bold text-mt-white pb-1;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.18), rgba(0, 0, 0, 0.18));
    border: 1px solid rgba(255, 255, 255, 0.24);
    backdrop-filter: blur(6px);
    width: 5rem;
    height: 2rem;
  }

  .monitoring-invite-button__icon {
    width: 0.95rem;
    height: 0.95rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  :global(.monitoring-invite-button__icon svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
</style>
