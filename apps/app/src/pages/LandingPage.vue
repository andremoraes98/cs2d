<script setup lang="ts">
import UiIcon from '@/ui/UiIcon.vue'
import Cs2Mark from '@/shell/Cs2Mark.vue'
import LocaleMenu from '@/shell/LocaleMenu.vue'
import { useI18n } from '@/app/i18n'
import { APP_HOME } from '@/app/paths'

// First-visit landing at `/`: what the tool does and how it works, with a way into
// the app. Returning users and the installed PWA never see it (see the guard in
// app/router.ts), so it can stay purely explanatory.
const { t } = useI18n()

const GITHUB_URL = 'https://github.com/zenojunior/cs2d'

const STEPS = [
  { icon: 'upload', key: 'step1' },
  { icon: 'bolt', key: 'step2' },
  { icon: 'play-circle', key: 'step3' },
] as const

const FEATURES = [
  { icon: 'map', key: 'replay' },
  { icon: 'flame', key: 'heatmaps' },
  { icon: 'target', key: 'duels' },
  { icon: 'grid', key: 'utilities' },
  { icon: 'dollar', key: 'economy' },
  { icon: 'library', key: 'offline' },
] as const
</script>

<template>
  <div class="h-dvh overflow-y-auto bg-ink-950 text-ink-100">
    <header
      class="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-ink-800/80 bg-ink-950/80 px-4 backdrop-blur-md sm:px-6"
    >
      <div class="flex items-center gap-2">
        <Cs2Mark size="sm" />
        <span class="text-sm font-medium">CS2d.app</span>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <a
          :href="GITHUB_URL"
          target="_blank"
          rel="noopener noreferrer"
          :aria-label="t('shell.github')"
          class="flex cursor-pointer items-center gap-1.5 rounded-md border border-ink-700 bg-ink-900/60 px-2 py-1 text-xs font-medium text-ink-200 transition-colors hover:bg-ink-800"
        >
          <UiIcon name="github" class="h-3.5 w-3.5 text-ink-400" />
          <span class="hidden sm:inline">GitHub</span>
        </a>
        <LocaleMenu />
        <RouterLink
          :to="APP_HOME"
          class="hidden items-center gap-1.5 rounded-md bg-surge-500 px-3 py-1.5 text-xs font-semibold text-ink-950 transition-colors hover:bg-surge-400 sm:inline-flex"
        >
          {{ t('landing.cta') }}
        </RouterLink>
      </div>
    </header>

    <main>
      <!-- Hero -->
      <section class="mx-auto max-w-5xl px-5 pb-10 pt-14 text-center sm:px-6 sm:pt-20">
        <p
          class="mx-auto inline-flex items-center gap-1.5 rounded-full border border-ink-700 bg-ink-900/60 px-3 py-1 text-xs text-ink-300"
        >
          <UiIcon name="lock" class="h-3 w-3 text-surge-400" />
          {{ t('landing.badge') }}
        </p>
        <h1 class="mx-auto mt-5 max-w-3xl font-display text-4xl font-bold tracking-tight sm:text-6xl">
          {{ t('landing.title') }}
        </h1>
        <p class="mx-auto mt-5 max-w-2xl text-base text-ink-300 sm:text-lg">
          {{ t('landing.subtitle') }}
        </p>
        <div class="mt-8 flex flex-wrap items-center justify-center gap-3">
          <RouterLink
            :to="APP_HOME"
            class="inline-flex items-center gap-2 rounded-lg bg-surge-500 px-5 py-2.5 text-sm font-semibold text-ink-950 transition-colors hover:bg-surge-400"
          >
            {{ t('landing.cta') }}
            <UiIcon name="arrow-right" class="h-4 w-4" />
          </RouterLink>
          <a
            :href="GITHUB_URL"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-900/60 px-5 py-2.5 text-sm font-medium text-ink-200 transition-colors hover:bg-ink-800"
          >
            <UiIcon name="github" class="h-4 w-4" />
            {{ t('landing.secondary') }}
          </a>
        </div>

        <img
          src="/showcase.webp"
          :alt="t('landing.showcaseAlt')"
          width="2560"
          height="1260"
          fetchpriority="high"
          class="mx-auto mt-12 w-full rounded-xl border border-ink-700 shadow-2xl shadow-black/60"
        />
      </section>

      <!-- How it works -->
      <section class="mx-auto max-w-5xl px-5 py-12 sm:px-6">
        <h2 class="text-center font-display text-2xl font-semibold sm:text-3xl">
          {{ t('landing.howTitle') }}
        </h2>
        <ol class="mt-8 grid gap-4 sm:grid-cols-3">
          <li
            v-for="step in STEPS"
            :key="step.key"
            class="rounded-xl border border-ink-800 bg-ink-900/60 p-5"
          >
            <div class="flex items-center gap-3">
              <span
                class="grid h-9 w-9 place-items-center rounded-lg bg-ink-800 text-surge-400"
              >
                <UiIcon :name="step.icon" class="h-4 w-4" />
              </span>
            </div>
            <h3 class="mt-4 font-medium">{{ t(`landing.${step.key}Title`) }}</h3>
            <p class="mt-1.5 text-sm text-ink-300">{{ t(`landing.${step.key}Body`) }}</p>
          </li>
        </ol>
      </section>

      <!-- Features -->
      <section class="mx-auto max-w-5xl px-5 py-12 sm:px-6">
        <h2 class="text-center font-display text-2xl font-semibold sm:text-3xl">
          {{ t('landing.featuresTitle') }}
        </h2>
        <ul class="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <li
            v-for="f in FEATURES"
            :key="f.key"
            class="rounded-xl border border-ink-800 bg-ink-900/60 p-5"
          >
            <UiIcon :name="f.icon" class="h-5 w-5 text-surge-400" />
            <h3 class="mt-3 font-medium">{{ t(`landing.${f.key}Title`) }}</h3>
            <p class="mt-1.5 text-sm text-ink-300">{{ t(`landing.${f.key}Body`) }}</p>
          </li>
        </ul>
      </section>

      <!-- Privacy -->
      <section class="mx-auto max-w-3xl px-5 py-12 text-center sm:px-6">
        <UiIcon name="shield" class="mx-auto h-8 w-8 text-surge-400" />
        <h2 class="mt-4 font-display text-2xl font-semibold sm:text-3xl">
          {{ t('landing.privacyTitle') }}
        </h2>
        <p class="mt-3 text-ink-300">{{ t('landing.privacyBody') }}</p>
      </section>

      <!-- Final call to action -->
      <section class="mx-auto max-w-3xl px-5 pb-20 pt-6 text-center sm:px-6">
        <RouterLink
          :to="APP_HOME"
          class="inline-flex items-center gap-2 rounded-lg bg-surge-500 px-6 py-3 text-sm font-semibold text-ink-950 transition-colors hover:bg-surge-400"
        >
          {{ t('landing.finalCta') }}
          <UiIcon name="arrow-right" class="h-4 w-4" />
        </RouterLink>
      </section>
    </main>

    <footer
      class="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 border-t border-ink-800/80 px-5 py-6 text-xs text-ink-400"
    >
      <span>CS2d.app</span>
      <RouterLink to="/project" class="transition-colors hover:text-ink-200">
        {{ t('shell.project') }}
      </RouterLink>
      <RouterLink to="/privacy" class="transition-colors hover:text-ink-200">
        {{ t('shell.privacy') }}
      </RouterLink>
    </footer>
  </div>
</template>
