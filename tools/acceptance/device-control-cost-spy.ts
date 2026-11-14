// The one place where the cost witness meets untyped values: the browser prototype it wraps and the controller it observes.
// Each helper narrows `unknown` once with a schema and hands typed notifications to its caller, so the measurement code
// never handles an untyped value.
import { z } from "zod";

const callable = z.instanceof(Function);
const text = z.string();
const promise = z.instanceof(Promise);
const objectValue = z.looseObject({});

/* oxlint-disable anti-slop/no-reflect-get, anti-slop/no-reflect-apply -- both helpers forward by property name on objects whose members have no static type at this boundary, so Reflect is the only typed way to read and call them */

// Counts every call of the audio context's factory methods whose name matches, then runs the original.
export const countFactoryCalls = (prototype: BaseAudioContext, pattern: RegExp, onCall: (name: string) => void) => {
  for (const name of Object.getOwnPropertyNames(prototype)) {
    const original = callable.safeParse(Object.getOwnPropertyDescriptor(prototype, name)?.value);
    if (!pattern.test(name) || !original.success) continue;
    Reflect.set(prototype, name, function counted(this: BaseAudioContext, ...args: unknown[]) {
      onCall(name);
      return Reflect.apply(original.data, this, args);
    });
  }
};

export type ObservedCall = { name: string; property: string; reason: string | undefined };
export type CallObserver = {
  // Before the real method runs; `reason` is its second argument when that is text.
  call: (call: ObservedCall) => void;
  // After it returned a promise.
  result: (property: string, outcome: Promise<unknown>) => void;
};

// A transparent proxy: every method call is reported to the observer and then forwarded; the nested control object is observed too.
export const observeCalls = <Target extends object>(target: Target, observer: CallObserver, prefix = ""): Target => new Proxy(target, {
  get(object, property) {
    const value: unknown = Reflect.get(object, property);
    const key = text.safeParse(property);
    if (!key.success) return value;
    const method = callable.safeParse(value);
    if (method.success) {
      return (...args: unknown[]) => {
        const reason = text.safeParse(args[1]);
        observer.call({ name: `${prefix}${key.data}`, property: key.data, reason: reason.success ? reason.data : undefined });
        const result: unknown = Reflect.apply(method.data, object, args);
        const outcome = promise.safeParse(result);
        if (outcome.success) observer.result(key.data, outcome.data);
        return result;
      };
    }
    const nested = objectValue.safeParse(value);
    return key.data === "liveProcessorControl" && nested.success ? observeCalls(nested.data, observer, "liveProcessorControl.") : value;
  },
});
/* oxlint-enable anti-slop/no-reflect-get, anti-slop/no-reflect-apply */
