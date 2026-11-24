import type { Component, ParentProps } from "solid-js"
import type { JSX, ValidComponent } from "@solidjs/web"
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

const checkedItemClass =
  "relative flex cursor-default select-none items-center py-1.5 pl-8 pr-2 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"

const ItemCheck: Component = () => (
  <DropdownMenuPrimitive.ItemIndicator class="absolute left-2 inline-flex h-4 w-4 items-center justify-center">
    <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" />
    </svg>
  </DropdownMenuPrimitive.ItemIndicator>
)

const DropdownMenuCheckboxItem: Component<ParentProps<DropdownMenuPrimitive.DropdownMenuCheckboxItemProps & { class?: string }>> = (props) => {
  const rest = omit(props, "class", "children")

  return (
    <DropdownMenuPrimitive.CheckboxItem class={cn(checkedItemClass, props.class)} {...rest}>
      <ItemCheck />
      {props.children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

const DropdownMenuRadioItem: Component<ParentProps<DropdownMenuPrimitive.DropdownMenuRadioItemProps & { class?: string }>> = (props) => {
  const rest = omit(props, "class", "children")

  return (
    <DropdownMenuPrimitive.RadioItem class={cn(checkedItemClass, props.class)} {...rest}>
      <ItemCheck />
      {props.children}
    </DropdownMenuPrimitive.RadioItem>
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem
}
