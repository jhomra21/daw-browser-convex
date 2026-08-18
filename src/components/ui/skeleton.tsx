import type { JSX, ValidComponent } from "solid-js"
import { splitProps } from "solid-js"

import type { PolymorphicProps } from "@kobalte/core/polymorphic"
import * as SkeletonPrimitive from "@kobalte/core/skeleton"

import { cn } from "~/lib/utils"

type SkeletonRootProps<T extends ValidComponent = "div"> =
  SkeletonPrimitive.SkeletonRootProps<T> & { class?: string | undefined }

function Skeleton<T extends ValidComponent = "div">(
  props: PolymorphicProps<T, SkeletonRootProps<T>>,
): JSX.Element
function Skeleton(
  props: PolymorphicProps<ValidComponent, SkeletonRootProps<ValidComponent>>,
): JSX.Element {
  const [local, others] = splitProps(props, ["class"])
  return (
    <SkeletonPrimitive.Root
      class={cn("bg-primary/10 data-[animate='true']:animate-pulse", local.class)}
      {...others}
    />
  )
}

export { Skeleton }
