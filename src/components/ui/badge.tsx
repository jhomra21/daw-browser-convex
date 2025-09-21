import type { JSX, ValidComponent } from "solid-js"
import { splitProps } from "solid-js"

import type { PolymorphicProps } from "@kobalte/core/polymorphic"
import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

import { cn } from "~/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive: "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
        outline: "text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export type BadgeProps<T extends ValidComponent = "span"> =
  PolymorphicProps<T, { class?: string; children?: JSX.Element } & VariantProps<typeof badgeVariants>>

export const Badge = <T extends ValidComponent = "span">(
  props: BadgeProps<T>
) => {
  const [local, others] = splitProps(props as BadgeProps, ["class", "variant"])
  return (
    <span class={cn(badgeVariants({ variant: local.variant }), local.class)} {...others} />
  )
}

export { badgeVariants }
