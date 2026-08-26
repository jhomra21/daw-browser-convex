import type { JSX, ValidComponent } from "solid-js"
import { splitProps } from "solid-js"

import type { PolymorphicProps } from "@kobalte/core/polymorphic"
import * as SeparatorPrimitive from "@kobalte/core/separator"

import { cn } from "~/lib/utils"

type SeparatorRootProps<T extends ValidComponent = "hr"> =
  SeparatorPrimitive.SeparatorRootProps<T> & { class?: string | undefined }

function Separator<T extends ValidComponent = "hr">(
  props: PolymorphicProps<T, SeparatorRootProps<T>>,
): JSX.Element
function Separator(
  props: PolymorphicProps<ValidComponent, SeparatorRootProps<ValidComponent>>,
): JSX.Element {
  const [local, others] = splitProps(props, ["class", "orientation"])
  return (
    <SeparatorPrimitive.Root
      orientation={local.orientation ?? "horizontal"}
      class={cn(
        "shrink-0 bg-border",
        local.orientation === "vertical" ? "h-full w-px" : "h-px w-full",
        local.class
      )}
      {...others}
    />
  )
}

export { Separator }
