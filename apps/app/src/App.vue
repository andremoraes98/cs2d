<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import PublicShell from '@/shell/PublicShell.vue'
import PwaPrompt from '@/shell/PwaPrompt.vue'
import { useSeoHead } from '@/app/seo'

// The landing renders on its own; every other page sits inside the lean public
// shell (sidebar + top bar).
const route = useRoute()
const isLanding = computed(() => route.name === 'landing')

// Keep the document head (title, description, social tags, canonical) in sync
// with the active route and locale.
useSeoHead()
</script>

<template>
  <RouterView v-if="isLanding" />
  <PublicShell v-else />
  <PwaPrompt />
</template>
