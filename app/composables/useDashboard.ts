import { createSharedComposable } from '@vueuse/core'

const _useDashboard = () => {
  const router = useRouter()

  defineShortcuts({
    'g-p': () => router.push('/'),
    'g-l': () => router.push('/pipeline'),
    'g-r': () => router.push('/run'),
    'g-s': () => router.push('/settings')
  })

  return {}
}

export const useDashboard = createSharedComposable(_useDashboard)
