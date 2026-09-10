<script setup lang="ts">
useDashboard()
useHead({ title: 'Pipeline' })
</script>

<template>
  <UDashboardPanel id="pipeline">
    <template #header>
      <UDashboardNavbar title="Pipeline">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <div class="py-16 text-center">
        <UIcon
          name="i-lucide-send"
          class="size-8 text-muted mb-2"
        />
        <p class="text-muted">
          Recruiter stages, follow-up countdowns and Gmail sync land here in M4.
        </p>
      </div>
    </template>
  </UDashboardPanel>
</template>
