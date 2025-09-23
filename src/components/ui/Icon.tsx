import { Component, JSX, splitProps, createUniqueId } from "solid-js";

export type IconName = "google" | "solidjs";

type BaseIconProps = {
  size?: number | string;
  class?: string;
  title?: string;
  ariaLabel?: string;
};

export type IconProps = BaseIconProps & {
  name: IconName;
} & JSX.SvgSVGAttributes<SVGSVGElement>;

const normalizeSize = (size?: number | string) =>
  typeof size === "number" ? `${size}px` : size ?? "1em";

const GoogleIcon: Component<BaseIconProps & JSX.SvgSVGAttributes<SVGSVGElement>> = (props) => {
  const [local, rest] = splitProps(props, ["size", "class", "title", "ariaLabel"]);
  const s = normalizeSize(local.size);
  return (
    <svg
      {...rest}
      width={s}
      height={s}
      viewBox="0 0 256 262"
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid"
      class={local.class}
      role={local.ariaLabel ? "img" : undefined}
      aria-label={local.ariaLabel}
      aria-hidden={local.ariaLabel ? undefined : "true"}
    >
      {local.title ? <title>{local.title}</title> : null}
      <path d="M255.878 133.451c0-10.734-.871-18.567-2.756-26.69H130.55v48.448h71.947c-1.45 12.04-9.283 30.172-26.69 42.356l-.244 1.622 38.755 30.023 2.685.268c24.659-22.774 38.875-56.282 38.875-96.027" fill="#4285F4"/>
      <path d="M130.55 261.1c35.248 0 64.839-11.605 86.453-31.622l-41.196-31.913c-11.024 7.688-25.82 13.055-45.257 13.055-34.523 0-63.824-22.773-74.269-54.25l-1.531.13-40.298 31.187-.527 1.465C35.393 231.798 79.49 261.1 130.55 261.1" fill="#34A853"/>
      <path d="M56.281 156.37c-2.756-8.123-4.351-16.827-4.351-25.82 0-8.994 1.595-17.697 4.206-25.82l-.073-1.73L15.26 71.312l-1.335.635C5.077 89.644 0 109.517 0 130.55s5.077 40.905 13.925 58.602l42.356-32.782" fill="#FBBC05"/>
      <path d="M130.55 50.479c24.514 0 41.05 10.589 50.479 19.438l36.844-35.974C195.245 12.91 165.798 0 130.55 0 79.49 0 35.393 29.301 13.925 71.947l42.211 32.783c10.59-31.477 39.891-54.251 74.414-54.251" fill="#EB4335"/>
    </svg>
  );
};

const SolidJSIcon: Component<BaseIconProps & JSX.SvgSVGAttributes<SVGSVGElement>> = (props) => {
  const [local, rest] = splitProps(props, ["size", "class", "title", "ariaLabel"]);
  const s = normalizeSize(local.size);
  const uid = `solid-${createUniqueId()}`;
  const idA = `${uid}-a`;
  const idB = `${uid}-b`;
  const idC = `${uid}-c`;
  const idD = `${uid}-d`;

  return (
    <svg
      {...rest}
      width={s}
      height={s}
      viewBox="0 0 256 239"
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid"
      class={local.class}
      role={local.ariaLabel ? "img" : undefined}
      aria-label={local.ariaLabel}
      aria-hidden={local.ariaLabel ? undefined : "true"}
    >
      {local.title ? <title>{local.title}</title> : null}
      <defs>
        <linearGradient x1="-5.859%" y1="38.27%" x2="91.406%" y2="60.924%" id={idA}>
          <stop stop-color="#76B3E1" offset="10%"/>
          <stop stop-color="#DCF2FD" offset="30%"/>
          <stop stop-color="#76B3E1" offset="100%"/>
        </linearGradient>
        <linearGradient x1="56.996%" y1="38.44%" x2="37.941%" y2="68.375%" id={idB}>
          <stop stop-color="#76B3E1" offset="0%"/>
          <stop stop-color="#4377BB" offset="50%"/>
          <stop stop-color="#1F3B77" offset="100%"/>
        </linearGradient>
        <linearGradient x1="10.709%" y1="34.532%" x2="104.337%" y2="70.454%" id={idC}>
          <stop stop-color="#315AA9" offset="0%"/>
          <stop stop-color="#518AC8" offset="50%"/>
          <stop stop-color="#315AA9" offset="100%"/>
        </linearGradient>
        <linearGradient x1="61.993%" y1="29.58%" x2="17.762%" y2="105.119%" id={idD}>
          <stop stop-color="#4377BB" offset="0%"/>
          <stop stop-color="#1A336B" offset="50%"/>
          <stop stop-color="#1A336B" offset="100%"/>
        </linearGradient>
      </defs>
      <path d="M256 50.473S170.667-12.32 104.654 2.17l-4.83 1.61c-9.66 3.22-17.71 8.05-22.541 14.49l-3.22 4.83-24.151 41.862 41.862 8.05c17.71 11.271 40.251 16.101 61.182 11.271l74.063 14.49L256 50.474Z" fill="#76B3E1"/>
      <path d="M256 50.473S170.667-12.32 104.654 2.17l-4.83 1.61c-9.66 3.22-17.71 8.05-22.541 14.49l-3.22 4.83-24.151 41.862 41.862 8.05c17.71 11.271 40.251 16.101 61.182 11.271l74.063 14.49L256 50.474Z" fill={`url(#${idA})`} opacity=".3"/>
      <path d="m77.283 50.473-6.44 1.61c-27.371 8.05-35.422 33.811-20.931 56.352 16.1 20.931 49.912 32.201 77.283 24.151l99.824-33.811S141.686 35.982 77.283 50.473Z" fill="#518AC8"/>
      <path d="m77.283 50.473-6.44 1.61c-27.371 8.05-35.422 33.811-20.931 56.352 16.1 20.931 49.912 32.201 77.283 24.151l99.824-33.811S141.686 35.982 77.283 50.473Z" fill={`url(#${idB})`} opacity=".3"/>
      <path d="M209.308 122.926c-18.44-23.037-49.007-32.59-77.283-24.151l-99.824 32.201L0 187.328l180.327 30.591 32.201-57.962c6.44-11.27 4.83-24.15-3.22-37.031Z" fill={`url(#${idC})`}/>
      <path d="M177.107 179.278c-18.44-23.037-49.008-32.59-77.283-24.151L0 187.328s85.333 64.403 151.346 48.302l4.83-1.61c27.371-8.05 37.032-33.811 20.93-54.742Z" fill={`url(#${idD})`}/>
    </svg>
  );
};

const registry: Record<IconName, Component<BaseIconProps & JSX.SvgSVGAttributes<SVGSVGElement>>> = {
  google: GoogleIcon,
  solidjs: SolidJSIcon,
};

const Icon: Component<IconProps> = (allProps) => {
  const [props, rest] = splitProps(allProps, ["name", "size", "class", "title", "ariaLabel"]);
  const Svg = registry[props.name];
  if (!Svg) return null;
  return (
    <Svg
      size={props.size}
      class={props.class}
      title={props.title}
      ariaLabel={props.ariaLabel}
      {...rest}
    />
  );
};

export default Icon;
