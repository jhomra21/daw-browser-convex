import type { JSX, ValidComponent } from "solid-js"
import { mergeProps, splitProps } from "solid-js"

import type { PolymorphicProps } from "@kobalte/core"
import * as TextFieldPrimitive from "@kobalte/core/text-field"
import { cva } from "class-variance-authority"

import { cn } from "~/lib/utils"

type TextFieldRootProps<T extends ValidComponent = "div"> =
  TextFieldPrimitive.TextFieldRootProps<T> & {
    class?: string | undefined
  }

function TextField<T extends ValidComponent = "div">(
  props: PolymorphicProps<T, TextFieldRootProps<T>>,
): JSX.Element
function TextField(
  props: PolymorphicProps<ValidComponent, TextFieldRootProps<ValidComponent>>,
): JSX.Element {
  const [local, others] = splitProps(props, ["class"])
  return <TextFieldPrimitive.Root class={cn("flex flex-col gap-1", local.class)} {...others} />
}

type TextFieldInputProps<T extends ValidComponent = "input"> =
  TextFieldPrimitive.TextFieldInputProps<T> & {
    class?: string | undefined
    type?:
      | "button"
      | "checkbox"
      | "color"
      | "date"
      | "datetime-local"
      | "email"
      | "file"
      | "hidden"
      | "image"
      | "month"
      | "number"
      | "password"
      | "radio"
      | "range"
      | "reset"
      | "search"
      | "submit"
      | "tel"
      | "text"
      | "time"
      | "url"
      | "week"
  }

function TextFieldInput<T extends ValidComponent = "input">(
  props: PolymorphicProps<T, TextFieldInputProps<T>>,
): JSX.Element
function TextFieldInput(
  rawProps: PolymorphicProps<ValidComponent, TextFieldInputProps<ValidComponent>>,
): JSX.Element {
  const props = mergeProps({ type: "text" }, rawProps)
  const [local, others] = splitProps(props, ["type", "class"])
  return (
    <TextFieldPrimitive.Input
      type={local.type}
      class={cn(
        "flex h-10 w-full border border-input bg-transparent px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[invalid]:border-error-foreground data-[invalid]:text-error-foreground",
        local.class
      )}
      {...others}
    />
  )
}

type TextFieldTextAreaProps<T extends ValidComponent = "textarea"> =
  TextFieldPrimitive.TextFieldTextAreaProps<T> & { class?: string | undefined }

function TextFieldTextArea<T extends ValidComponent = "textarea">(
  props: PolymorphicProps<T, TextFieldTextAreaProps<T>>,
): JSX.Element
function TextFieldTextArea(
  props: PolymorphicProps<ValidComponent, TextFieldTextAreaProps<ValidComponent>>,
): JSX.Element {
  const [local, others] = splitProps(props, ["class"])
  return (
    <TextFieldPrimitive.TextArea
      class={cn(
        "flex min-h-20 w-full border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        local.class
      )}
      {...others}
    />
  )
}

const labelVariants = cva(
  "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
  {
    variants: {
      variant: {
        label: "data-[invalid]:text-destructive",
        description: "font-normal text-muted-foreground",
        error: "text-xs text-destructive"
      }
    },
    defaultVariants: {
      variant: "label"
    }
  }
)

type TextFieldLabelProps<T extends ValidComponent = "label"> =
  TextFieldPrimitive.TextFieldLabelProps<T> & { class?: string | undefined }

function TextFieldLabel<T extends ValidComponent = "label">(
  props: PolymorphicProps<T, TextFieldLabelProps<T>>,
): JSX.Element
function TextFieldLabel(
  props: PolymorphicProps<ValidComponent, TextFieldLabelProps<ValidComponent>>,
): JSX.Element {
  const [local, others] = splitProps(props, ["class"])
  return <TextFieldPrimitive.Label class={cn(labelVariants(), local.class)} {...others} />
}

type TextFieldDescriptionProps<T extends ValidComponent = "div"> =
  TextFieldPrimitive.TextFieldDescriptionProps<T> & {
    class?: string | undefined
  }

function TextFieldDescription<T extends ValidComponent = "div">(
  props: PolymorphicProps<T, TextFieldDescriptionProps<T>>,
): JSX.Element
function TextFieldDescription(
  props: PolymorphicProps<ValidComponent, TextFieldDescriptionProps<ValidComponent>>,
): JSX.Element {
  const [local, others] = splitProps(props, ["class"])
  return (
    <TextFieldPrimitive.Description
      class={cn(labelVariants({ variant: "description" }), local.class)}
      {...others}
    />
  )
}

type TextFieldErrorMessageProps<T extends ValidComponent = "div"> =
  TextFieldPrimitive.TextFieldErrorMessageProps<T> & {
    class?: string | undefined
  }

function TextFieldErrorMessage<T extends ValidComponent = "div">(
  props: PolymorphicProps<T, TextFieldErrorMessageProps<T>>,
): JSX.Element
function TextFieldErrorMessage(
  props: PolymorphicProps<ValidComponent, TextFieldErrorMessageProps<ValidComponent>>,
): JSX.Element {
  const [local, others] = splitProps(props, ["class"])
  return (
    <TextFieldPrimitive.ErrorMessage
      class={cn(labelVariants({ variant: "error" }), local.class)}
      {...others}
    />
  )
}

export {
  TextField,
  TextFieldInput,
  TextFieldTextArea,
  TextFieldLabel,
  TextFieldDescription,
  TextFieldErrorMessage
}
