<script lang="ts">
  import { activeWizardNow } from '../../stores/dialogs';
  import WizardMonitoringInvite from '../wizards/wizard-monitoring-invite.svelte';
</script>

{#if $activeWizardNow.name === 'monitoring-invite-wizard'}
  <WizardMonitoringInvite />
{/if}
