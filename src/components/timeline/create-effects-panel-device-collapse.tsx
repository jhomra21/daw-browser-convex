import { createContext, createEffect, createSignal, useContext, type Accessor, type ParentComponent } from "solid-js";
import { REORDER_ACTIVATION_THRESHOLD_PX } from "~/components/timeline/device-interaction";

export const DEVICE_COLLAPSE_STORAGE_KEY = "timeline:device-collapse";
export const DEVICE_DOUBLE_TAP_MS = 700;
export const DEVICE_DOUBLE_TAP_DISTANCE_PX = 8;

export type DeviceCollapseIdentity =
  | `arp:${string}`
  | `instrument:${string}`
  | `audio-effect:${string}`
  | `external:${string}`;

export const deviceCollapseIdentity = {
  arp: (targetId: string): DeviceCollapseIdentity => `arp:${targetId}`,
  instrument: (instanceId: string): DeviceCollapseIdentity => `instrument:${instanceId}`,
  audioEffect: (instanceId: string): DeviceCollapseIdentity => `audio-effect:${instanceId}`,
  external: (instanceId: string): DeviceCollapseIdentity => `external:${instanceId}`,
};

const canUseStorage = () => {
  if (typeof window === "undefined") return false;
  try {
    return Boolean(window.localStorage);
  } catch {
    return false;
  }
};

export const parseCollapsedDeviceIdentities = (raw: string | null): Set<string> => {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
};

export const serializeCollapsedDeviceIdentities = (identities: ReadonlySet<string>) => (
  JSON.stringify(Array.from(identities).sort())
);

export const deviceCollapseStorageKey = (projectId: string) => `${DEVICE_COLLAPSE_STORAGE_KEY}:${projectId}`;

export function createEffectsPanelDeviceCollapse(projectId: Accessor<string | undefined>) {
  const [collapsedIdentities, setCollapsedIdentities] = createSignal<Set<string>>(new Set());
  let loadedProjectId: string | undefined;

  const reload = () => {
    const currentProjectId = projectId();
    if (currentProjectId === loadedProjectId) return;
    loadedProjectId = currentProjectId;
    if (!currentProjectId || !canUseStorage()) {
      setCollapsedIdentities(new Set<string>());
      return;
    }
    try {
      setCollapsedIdentities(parseCollapsedDeviceIdentities(window.localStorage.getItem(deviceCollapseStorageKey(currentProjectId))));
    } catch {
      setCollapsedIdentities(new Set<string>());
    }
  };

  createEffect(reload);

  const setCollapsed = (identity: DeviceCollapseIdentity, collapsed: boolean) => {
    reload();
    const next = new Set(collapsedIdentities());
    if (collapsed) next.add(identity);
    else next.delete(identity);
    setCollapsedIdentities(next);
    const currentProjectId = projectId();
    if (!currentProjectId || !canUseStorage()) return;
    try {
      window.localStorage.setItem(deviceCollapseStorageKey(currentProjectId), serializeCollapsedDeviceIdentities(next));
    } catch {}
  };

  const isCollapsed = (identity: DeviceCollapseIdentity) => collapsedIdentities().has(identity);

  return {
    isCollapsed,
    setCollapsed,
    toggle: (identity: DeviceCollapseIdentity) => setCollapsed(identity, !collapsedIdentities().has(identity)),
  };
}

export type DeviceCollapseContextValue = {
  collapsed: Accessor<boolean>;
  toggle: () => void;
  contentId: Accessor<string>;
  canWrite: Accessor<boolean>;
};

const DeviceCollapseContext = createContext<DeviceCollapseContextValue>();

export const useDeviceCollapseContext = () => useContext(DeviceCollapseContext);

export const DeviceCollapseProvider: ParentComponent<DeviceCollapseContextValue> = (props) => (
  <DeviceCollapseContext.Provider value={props}>
    {props.children}
  </DeviceCollapseContext.Provider>
);

const stableHash = (value: string) => {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export const safeDeviceContentId = (identity: string) => (
  `device-content-${identity.replace(/[^a-zA-Z0-9_-]/g, "-")}-${stableHash(identity)}`
);

export type DeviceCollapseGesture =
  | {
    identity: string;
    at: number;
    x: number;
    y: number;
    pointerType: string;
    deviceId: string;
  }
  | undefined;

export type DeviceCollapseGestureResult = {
  next: DeviceCollapseGesture;
  recognized: boolean;
};

export const devicePointerIdentity = (event: Pick<PointerEvent, "pointerType"> & { persistentDeviceId?: string }) => (
  typeof event.persistentDeviceId === "string" && event.persistentDeviceId.length > 0
    ? event.persistentDeviceId
    : event.pointerType
);

export const recognizeDeviceDoubleTap = (
  previous: DeviceCollapseGesture,
  current: Exclude<DeviceCollapseGesture, undefined>,
): DeviceCollapseGestureResult => {
  const recognized = Boolean(
    previous
    && previous.identity === current.identity
    && previous.pointerType === current.pointerType
    && previous.deviceId === current.deviceId
    && current.at - previous.at <= DEVICE_DOUBLE_TAP_MS
    && Math.abs(current.x - previous.x) <= DEVICE_DOUBLE_TAP_DISTANCE_PX
    && Math.abs(current.y - previous.y) <= DEVICE_DOUBLE_TAP_DISTANCE_PX,
  );
  return { next: recognized ? undefined : current, recognized };
};

export const cancelDeviceDoubleTapOnMove = (
  previous: DeviceCollapseGesture,
  start: { x: number; y: number } | undefined,
  current: { x: number; y: number },
) => (
  previous && start
  && Math.hypot(current.x - start.x, current.y - start.y) >= REORDER_ACTIVATION_THRESHOLD_PX
    ? undefined
    : previous
);
