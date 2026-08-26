import type {
  Accessor,
  Component,
  ComponentProps,
  JSX,
  ValidComponent,
} from "solid-js";
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  mergeProps,
  splitProps,
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

const useMenubarAnimation = () => {
  const context = useContext(MenubarAnimationContext);
  return assertDefined(context, "MenubarContent must be used within Menubar.");
};

const useMenubarMenuValue = () => {
  const value = useContext(MenubarMenuValueContext);
  return () => assertDefined(value?.(), "MenubarContent must be used within MenubarMenu.");
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
  const [local, rest] = splitProps(props, ["onValueChange"]);

  createEffect(() => {
    if (props.value !== undefined) setCurrentValue(props.value);
  });

  return (
    <MenubarAnimationContext.Provider value={{ animation }}>
      <MenubarPrimitive.Root
        {...rest}
        onValueChange={(nextValue) => {
          const previousValue = currentValue();
          setAnimation({
            animate: previousValue == null || nextValue == null,
            value: nextValue ?? previousValue,
          });
          setCurrentValue(nextValue);
          local.onValueChange?.(nextValue);
        }}
      />
    </MenubarAnimationContext.Provider>
  );
};
const MenubarPortal = MenubarPrimitive.Portal;

const MenubarMenu: Component<MenubarPrimitive.MenubarMenuProps> = (props) => {
  const mergedProps = mergeProps({ gutter: 8, shift: -4 }, props);
  const value = createMemo(() => props.value);
  return (
    <MenubarMenuValueContext.Provider value={value}>
      <MenubarPrimitive.Menu {...mergedProps} />
    </MenubarMenuValueContext.Provider>
  );
};

const MenubarSub: Component<MenubarPrimitive.MenubarSubProps> = (props) => {
  const mergedProps = mergeProps({ gutter: 8 }, props);
  return <MenubarPrimitive.Sub {...mergedProps} />;
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
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <MenubarPrimitive.Trigger
      class={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium !cursor-pointer focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        "h-9 px-3 text-xs hover:bg-accent hover:text-accent-foreground data-[expanded]:bg-accent data-[expanded]:text-accent-foreground",
        local.class,
      )}
      {...rest}
    />
  );
};

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
  const [local, rest] = splitProps(props, ["class"]);
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
          local.class,
        )}
        {...rest}
      />
    </MenubarPrimitive.Portal>
  );
};

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
  const [local, rest] = splitProps(props, ["class", "inset"]);
  return (
    <MenubarPrimitive.Item
      class={cn(
        "relative flex min-h-6 cursor-default select-none items-center gap-2 whitespace-nowrap px-2 py-0.5 leading-5 outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>svg]:size-3.5 [&>svg]:shrink-0",
        local.inset && "pl-6",
        local.class,
      )}
      {...rest}
    />
  );
};

const MenubarShortcut: Component<ComponentProps<"span">> = (props) => {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <span
      class={cn("ml-auto shrink-0 whitespace-nowrap pl-4 text-[11px] tracking-wide opacity-60", local.class)}
      {...rest}
    />
  );
};

type MenubarLabelProps = ComponentProps<"div"> & {
  inset?: boolean;
  class?: string;
};

const MenubarLabel: Component<MenubarLabelProps> = (props) => {
  const [local, rest] = splitProps(props, ["class", "inset"]);
  return (
    <div
      class={cn(
        "px-2 py-1 text-xs font-semibold leading-5",
        local.inset && "pl-6",
        local.class,
      )}
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
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <MenubarPrimitive.Separator
      class={cn("-mx-0.5 my-0.5 h-px bg-muted", local.class)}
      {...rest}
    />
  );
};

type MenubarSubTriggerProps<T extends ValidComponent = "div"> =
  MenubarPrimitive.MenubarSubTriggerProps<T> & {
    class?: string | undefined;
    children?: JSX.Element;
    inset?: boolean;
  };

function MenubarSubTrigger<T extends ValidComponent = "div">(
  props: PolymorphicProps<T, MenubarSubTriggerProps<T>>,
): JSX.Element
function MenubarSubTrigger(
  props: PolymorphicProps<ValidComponent, MenubarSubTriggerProps<ValidComponent>>,
): JSX.Element {
  const [local, rest] = splitProps(props, ["class", "children", "inset"]);
  return (
    <MenubarPrimitive.SubTrigger
      class={cn(
        "flex min-h-6 cursor-default select-none items-center gap-2 px-2 py-0.5 text-xs leading-5 outline-none focus:bg-accent focus:text-accent-foreground data-[expanded]:bg-accent data-[expanded]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
        local.inset && "pl-6",
        local.class,
      )}
      {...rest}
    >
      {local.children}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        class="ml-auto size-3.5"
      >
        <path d="M9 6l6 6l-6 6" />
      </svg>
    </MenubarPrimitive.SubTrigger>
  );
};

type MenubarSubContentProps<T extends ValidComponent = "div"> =
  MenubarPrimitive.MenubarSubContentProps<T> & {
    class?: string | undefined;
  };

function MenubarSubContent<T extends ValidComponent = "div">(
  props: PolymorphicProps<T, MenubarSubContentProps<T>>,
): JSX.Element
function MenubarSubContent(
  props: PolymorphicProps<ValidComponent, MenubarSubContentProps<ValidComponent>>,
): JSX.Element {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <MenubarPrimitive.SubContent
      class={cn(
        "z-50 min-w-32 overflow-hidden border bg-popover p-0.5 text-xs text-popover-foreground shadow-lg outline-none",
        "origin-[var(--kb-menu-content-transform-origin)] data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95",
        "data-[placement=bottom]:slide-in-from-top-2 data-[placement=left]:slide-in-from-right-2 data-[placement=right]:slide-in-from-left-2 data-[placement=top]:slide-in-from-bottom-2",
        local.class,
      )}
      {...rest}
    />
  );
};

export {
  Menubar,
  MenubarMenu,
  MenubarTrigger,
  MenubarPortal,
  MenubarContent,
  MenubarItem,
  MenubarShortcut,
  MenubarLabel,
  MenubarSeparator,
  MenubarSub,
  MenubarSubTrigger,
  MenubarSubContent,
};
