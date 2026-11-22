import { createSignal, type Accessor } from "solid-js";

// Solid 2 setters publish at the next flush, so an imperative caller reading right after its own write sees the old
// value. The getter tracks a version signal and returns the latest written value, as a 1.x signal read did.
// Like createSignal, a function passed to the setter is an updater, so T must not itself be a function type.
export const createLatestSignal = <T>(initial: T): [Accessor<T>, (next: T | ((current: T) => T)) => void] => {
  const [version, setVersion] = createSignal(0);
  let latest = initial;

  const isUpdater = (value: T | ((current: T) => T)): value is (current: T) => T => typeof value === "function";

  const read = () => {
    version();

    return latest;
  };

  const write = (next: T | ((current: T) => T)) => {
    const value = isUpdater(next) ? next(latest) : next;

    if (value === latest) return;
    latest = value;
    setVersion((current) => current + 1);
  };

  return [read, write];
};
