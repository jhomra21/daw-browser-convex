import { createFileRoute } from '@tanstack/solid-router'

export const Route = createFileRoute('/about')({
  head: () => ({
    meta: [
      { title: 'About – Mediabunny' },
      { name: 'description', content: 'About page' },
    ],
  }),
  component: About,
})

function About() {
  return <div class="p-2">Hello from About!</div>
}
