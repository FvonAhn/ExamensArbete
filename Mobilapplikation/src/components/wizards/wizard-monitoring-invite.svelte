<script lang="ts">
  import { StaticWizardPages } from "../../utils/constants";
  import WizardDialog from "../dialogs/wizard-dialog.svelte";
  import MonitoringInvitePage from "../wizard-pages/broadcast/monitoring-invite-page.svelte";
</script>

<WizardDialog startPage="page1" title="Invite viewer">
  <MonitoringInvitePage slot="page1" backPage={StaticWizardPages.CLOSE} backText="Close" />
</WizardDialog>
