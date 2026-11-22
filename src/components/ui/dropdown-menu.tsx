import type { Component, JSX, ValidComponent } from "solid-js"
import { omit } from "solid-js"

import * as DropdownMenuPrimitive from "@kobalte/core/dropdown-menu"
import type { PolymorphicProps } from "@kobalte/core/polymorphic"

import { cn } from "~/lib/utils"

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

const DropdownMenu: Component<DropdownMenuPrimitive.DropdownMenuRootProps> = (props) => {
  return <DropdownMenuPrimitive.Root gutter={4} {...props} />
}

type DropdownMenuContentProps<T extends ValidComponent = "div"> =
  DropdownMenuPrimitive.DropdownMenuContentProps<T> & {
    class?: string | undefined
  }

function DropdownMenuContent<T extends ValidComponent = "div">(
  props: PolymorphicProps<T, DropdownMenuContentProps<T>>,
): JSX.Element
function DropdownMenuContent(
  props: PolymorphicProps<ValidComponent, DropdownMenuContentProps<ValidComponent>>,
): JSX.Element {
  const rest = omit(props, "class")

  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        class={cn(
          "z-50 min-w-32 max-h-(--kb-menu-content-available-height) overflow-y-auto overflow-x-hidden border bg-popover p-1 text-popover-foreground shadow-md",
          props.class
        )}
        {...rest}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

type DropdownMenuItemProps<T extends ValidComponent = "div"> =
  DropdownMenuPrimitive.DropdownMenuItemProps<T> & {
    class?: string | undefined
    inset?: boolean
  }

function DropdownMenuItem<T extends ValidComponent = "div">(
  props: PolymorphicProps<T, DropdownMenuItemProps<T>>,
): JSX.Element
function DropdownMenuItem(
  props: PolymorphicProps<ValidComponent, DropdownMenuItemProps<ValidComponent>>,
): JSX.Element {
  const rest = omit(props, "class", "inset")

  return (
    <DropdownMenuPrimitive.Item
      class={cn(
        "relative flex cursor-default select-none items-center gap-2 px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0",
        props.inset && "pl-8",
        props.class
      )}
      {...rest}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
}
