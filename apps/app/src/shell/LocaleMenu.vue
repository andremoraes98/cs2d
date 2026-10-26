<script setup lang="ts">
import { computed } from 'vue'
import { Flag } from '@blade-flags/vue'
import { localeFlags } from '@/shell/localeFlags'
import UiIcon from '@/ui/UiIcon.vue'
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarTrigger,
} from '@/ui/menubar'
import { useI18n, type LocaleCode } from '@/app/i18n'

// Language picker shared by the app's top bar and the landing page.
const { t, locale, setLocale, LOCALES } = useI18n()
const current = computed(() => LOCALES.find((l) => l.code === locale.value) ?? LOCALES[0])
</script>

<template>
  <Menubar>
    <MenubarMenu>
      <MenubarTrigger :aria-label="t('shell.language')">
        <Flag :code="current.flag" :flags="localeFlags" class="h-4 w-4 shrink-0" />
        <span class="font-mono text-[11px] font-medium">{{ current.label }}</span>
        <UiIcon name="chevron-down" class="h-3 w-3 text-ink-500" />
      </MenubarTrigger>
      <MenubarContent align="end" class="max-h-72 w-44 overflow-y-auto">
        <MenubarItem
          v-for="l in LOCALES"
          :key="l.code"
          :class="locale === l.code ? 'bg-ink-800 text-ink-50' : ''"
          @select="setLocale(l.code as LocaleCode)"
        >
          <Flag :code="l.flag" :flags="localeFlags" class="h-4 w-4 shrink-0" />
          <span class="flex-1 truncate">{{ l.name }}</span>
          <UiIcon v-if="locale === l.code" name="check" class="h-3.5 w-3.5 shrink-0 text-surge-400" />
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  </Menubar>
</template>
