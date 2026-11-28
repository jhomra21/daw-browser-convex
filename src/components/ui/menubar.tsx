import type {
  Accessor,
  Component,
} from "solid-js";
import type { ComponentProps, JSX, ValidComponent } from "@solidjs/web";
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  merge,
  omit,
  untrack,
  useContext,
} from "solid-js";

import * as MenubarPrimitive from "@kobalte/core/menubar";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { assertDefined } from "@daw-browser/shared";

import { cn } from "~/lib/utils";

type MenubarAnimationState = {
  animate: boolean;
  value: string | null | undefined;
};

type MenubarAnimationContextValue = {
  animation: Accessor<MenubarAnimationState>;
};

const MenubarAnimationContext = createContext<MenubarAnimationContextValue>();
const MenubarMenuValueContext = createContext<Accessor<string | undefined>>();

const useMenubarAnimation = () => useContext(MenubarAnimationContext);

const useMenubarMenuValue = () => {
  const value = useContext(MenubarMenuValueContext);

  return () => assertDefined(value(), "MenubarContent must be used within MenubarMenu.");
};

type MenubarProps = MenubarPrimitive.MenubarRootProps & {
  children?: JSX.Element;
  class?: string;
};

const Menubar: Component<MenubarProps> = (props) => {
  const initialValue = untrack(() => props.value ?? props.defaultValue);

  const [animation, setAnimation] = createSignal<MenubarAnimationState>({
    animate: true,
    value: initialValue,
  });

  const [currentValue, setCurrentValue] = createSignal<
    string | null | undefined
  >(initialValue);

  const rest = omit(props, "onValueChange");

  createEffect(
    () => props.value,
    (value) => {
      if (value !== undefined) setCurrentValue(value);
    },
  );

  return (
    <MenubarAnimationContext value={{ animation }}>
      <MenubarPrimitive.Root
        {...rest}
        onValueChange={(nextValue) => {
          const previousValue = currentValue();
          setAnimation({
            animate: previousValue == null || nextValue == null,
            value: nextValue ?? previousValue,
          });
          setCurrentValue(nextValue);
          props.onValueChange?.(nextValue);
        }}
      />
    </MenubarAnimationContext>
  );
};

const MenubarMenu: Component<MenubarPrimitive.MenubarMenuProps> = (props) => {
  const mergedProps = merge({ gutter: 8, shift: -4 }, props);
  const value = createMemo(() => props.value);

  return (
    <MenubarMenuValueContext value={value}>
      <MenubarPrimitive.Menu {...mergedProps} />
    </MenubarMenuValueContext>
  );
};

type MenubarTriggerProps<T extends ValidComponent = "button"> =
  MenubarPrimitive.MenubarTriggerProps<T> & {
    class?: string | undefined;
  };

function MenubarTrigger<T extends ValidComponent = "button">(
  props: PolymorphicProps<T, MenubarTriggerProps<T>>,
): JSX.Element
function MenubarTrigger(
  props: PolymorphicProps<ValidComponent, MenubarTriggerProps<ValidComponent>>,
): JSX.Element {
  const rest = omit(props, "class");

  return (
    <MenubarPrimitive.Trigger
      class={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium !cursor-pointer focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        "h-9 px-3 text-xs hover:bg-accent hover:text-accent-foreground data-[expanded]:bg-accent data-[expanded]:text-accent-foreground",
        props.class,
      )}
      {...rest}
    />
  );
}

;

type MenubarContentProps<T extends ValidComponent = "div"> =
  MenubarPrimitive.MenubarContentProps<T> & {
    class?: string | undefined;
  };

function MenubarContent<T extends ValidComponent = "div">(
  props: PolymorphicProps<T, MenubarContentProps<T>>,
): JSX.Element
function MenubarContent(
  props: PolymorphicProps<ValidComponent, MenubarContentProps<ValidComponent>>,
): JSX.Element {
  const rest = omit(props, "class");
  const animation = useMenubarAnimation();
  const menuValue = useMenubarMenuValue();

  const shouldAnimate = () =>
    animation.animation().animate !== false &&
    menuValue() === animation.animation().value;

  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.Content
        class={cn(
          "z-50 w-max min-w-32 max-h-(--kb-menu-content-available-height) overflow-y-auto overflow-x-hidden border bg-popover p-0.5 text-xs text-popover-foreground shadow-md outline-none",
          shouldAnimate()
            ? "origin-[var(--kb-menu-content-transform-origin)] data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95 data-[placement=bottom]:slide-in-from-top-2 data-[placement=left]:slide-in-from-right-2 data-[placement=right]:slide-in-from-left-2 data-[placement=top]:slide-in-from-bottom-2"
            : "data-[closed]:hidden",
          props.class,
        )}
        {...rest}
      />
    </MenubarPrimitive.Portal>
  );
}

;

type MenubarItemProps<T extends ValidComponent = "div"> =
  MenubarPrimitive.MenubarItemProps<T> & {
    class?: string | undefined;
    inset?: boolean;
  };

function MenubarItem<T extends ValidComponent = "div">(
  props: PolymorphicProps<T, MenubarItemProps<T>>,
): JSX.Element
function MenubarItem(
  props: PolymorphicProps<ValidComponent, MenubarItemProps<ValidComponent>>,
): JSX.Element {
  const rest = omit(props, "class", "inset");

  return (
    <MenubarPrimitive.Item
      class={cn(
        "relative flex min-h-6 cursor-default select-none items-center gap-2 whitespace-nowrap px-2 py-0.5 leading-5 outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>svg]:size-3.5 [&>svg]:shrink-0",
        props.inset && "pl-6",
        props.class,
      )}
      {...rest}
    />
  );
}

;

const MenubarShortcut: Component<ComponentProps<"span">> = (props) => {
  const rest = omit(props, "class");

  return (
    <span
      class={cn("ml-auto shrink-0 whitespace-nowrap pl-4 text-[11px] tracking-wide opacity-60", props.class)}
      {...rest}
    />
  );
};

type MenubarSeparatorProps<T extends ValidComponent = "hr"> =
  MenubarPrimitive.MenubarSeparatorProps<T> & {
    class?: string | undefined;
  };

function MenubarSeparator<T extends ValidComponent = "hr">(
  props: PolymorphicProps<T, MenubarSeparatorProps<T>>,
): JSX.Element
function MenubarSeparator(
  props: PolymorphicProps<ValidComponent, MenubarSeparatorProps<ValidComponent>>,
): JSX.Element {
  const rest = omit(props, "class");

  return (
    <MenubarPrimitive.Separator
      class={cn("-mx-0.5 my-0.5 h-px bg-muted", props.class)}
      {...rest}
    />
  );
}

;

;

;

export {
  Menubar,
  MenubarMenu,
  MenubarTrigger,
  MenubarContent,
  MenubarItem,
  MenubarShortcut,
  MenubarSeparator,
};
