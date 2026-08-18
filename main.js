import { protocol as ks, app as ze, net as ru, session as Yn, ipcMain as de, BrowserWindow as ws, shell as nu, dialog as ln } from "electron";
import { createServer as ou } from "node:net";
import * as au from "node:fs/promises";
import { open as iu, stat as ur, writeFile as Is, rename as su, realpath as $o, readFile as Ss, readdir as xs, mkdir as yo, access as qo, chmod as eo, rm as bo } from "node:fs/promises";
import { existsSync as sr, constants as Ye, createReadStream as Ho } from "node:fs";
import { createHash as _n, randomBytes as Vr, randomUUID as zn, timingSafeEqual as cu } from "node:crypto";
import O from "node:path";
import { pathToFileURL as du } from "node:url";
import { tmpdir as lu } from "node:os";
import { spawn as Tn, execFile as uu } from "node:child_process";
import { promisify as pu } from "node:util";
function E(e, t, r) {
  function n(s, d) {
    if (s._zod || Object.defineProperty(s, "_zod", {
      value: {
        def: d,
        constr: i,
        traits: /* @__PURE__ */ new Set()
      },
      enumerable: !1
    }), s._zod.traits.has(e))
      return;
    s._zod.traits.add(e), t(s, d);
    const m = i.prototype, h = Object.keys(m);
    for (let g = 0; g < h.length; g++) {
      const S = h[g];
      S in s || (s[S] = m[S].bind(s));
    }
  }
  const o = r?.Parent ?? Object;
  class a extends o {
  }
  Object.defineProperty(a, "name", { value: e });
  function i(s) {
    var d;
    const m = r?.Parent ? new a() : this;
    n(m, s), (d = m._zod).deferred ?? (d.deferred = []);
    for (const h of m._zod.deferred)
      h();
    return m;
  }
  return Object.defineProperty(i, "init", { value: n }), Object.defineProperty(i, Symbol.hasInstance, {
    value: (s) => r?.Parent && s instanceof r.Parent ? !0 : s?._zod?.traits?.has(e)
  }), Object.defineProperty(i, "name", { value: e }), i;
}
class ir extends Error {
  constructor() {
    super("Encountered Promise during synchronous parse. Use .parseAsync() instead.");
  }
}
class Es extends Error {
  constructor(t) {
    super(`Encountered unidirectional transform during encode: ${t}`), this.name = "ZodEncodeError";
  }
}
const Ps = {};
function Tt(e) {
  return Ps;
}
function As(e) {
  const t = Object.values(e).filter((n) => typeof n == "number");
  return Object.entries(e).filter(([n, o]) => t.indexOf(+n) === -1).map(([n, o]) => o);
}
function vo(e, t) {
  return typeof t == "bigint" ? t.toString() : t;
}
function Rn(e) {
  return {
    get value() {
      {
        const t = e();
        return Object.defineProperty(this, "value", { value: t }), t;
      }
    }
  };
}
function Lo(e) {
  return e == null;
}
function Uo(e) {
  const t = e.startsWith("^") ? 1 : 0, r = e.endsWith("$") ? e.length - 1 : e.length;
  return e.slice(t, r);
}
function mu(e, t) {
  const r = (e.toString().split(".")[1] || "").length, n = t.toString();
  let o = (n.split(".")[1] || "").length;
  if (o === 0 && /\d?e-\d?/.test(n)) {
    const d = n.match(/\d?e-(\d?)/);
    d?.[1] && (o = Number.parseInt(d[1]));
  }
  const a = r > o ? r : o, i = Number.parseInt(e.toFixed(a).replace(".", "")), s = Number.parseInt(t.toFixed(a).replace(".", ""));
  return i % s / 10 ** a;
}
const Qa = Symbol("evaluating");
function ne(e, t, r) {
  let n;
  Object.defineProperty(e, t, {
    get() {
      if (n !== Qa)
        return n === void 0 && (n = Qa, n = r()), n;
    },
    set(o) {
      Object.defineProperty(e, t, {
        value: o
        // configurable: true,
      });
    },
    configurable: !0
  });
}
function Gt(e, t, r) {
  Object.defineProperty(e, t, {
    value: r,
    writable: !0,
    enumerable: !0,
    configurable: !0
  });
}
function Vt(...e) {
  const t = {};
  for (const r of e) {
    const n = Object.getOwnPropertyDescriptors(r);
    Object.assign(t, n);
  }
  return Object.defineProperties({}, t);
}
function Ja(e) {
  return JSON.stringify(e);
}
function fu(e) {
  return e.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
const _s = "captureStackTrace" in Error ? Error.captureStackTrace : (...e) => {
};
function Or(e) {
  return typeof e == "object" && e !== null && !Array.isArray(e);
}
const hu = Rn(() => {
  if (typeof navigator < "u" && navigator?.userAgent?.includes("Cloudflare"))
    return !1;
  try {
    const e = Function;
    return new e(""), !0;
  } catch {
    return !1;
  }
});
function cr(e) {
  if (Or(e) === !1)
    return !1;
  const t = e.constructor;
  if (t === void 0 || typeof t != "function")
    return !0;
  const r = t.prototype;
  return !(Or(r) === !1 || Object.prototype.hasOwnProperty.call(r, "isPrototypeOf") === !1);
}
function zs(e) {
  return cr(e) ? { ...e } : Array.isArray(e) ? [...e] : e;
}
const gu = /* @__PURE__ */ new Set(["string", "number", "symbol"]);
function dr(e) {
  return e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function Ot(e, t, r) {
  const n = new e._zod.constr(t ?? e._zod.def);
  return (!t || r?.parent) && (n._zod.parent = e), n;
}
function F(e) {
  const t = e;
  if (!t)
    return {};
  if (typeof t == "string")
    return { error: () => t };
  if (t?.message !== void 0) {
    if (t?.error !== void 0)
      throw new Error("Cannot specify both `message` and `error` params");
    t.error = t.message;
  }
  return delete t.message, typeof t.error == "string" ? { ...t, error: () => t.error } : t;
}
function yu(e) {
  return Object.keys(e).filter((t) => e[t]._zod.optin === "optional" && e[t]._zod.optout === "optional");
}
const bu = {
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-34028234663852886e22, 34028234663852886e22],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
function vu(e, t) {
  const r = e._zod.def, n = r.checks;
  if (n && n.length > 0)
    throw new Error(".pick() cannot be used on object schemas containing refinements");
  const a = Vt(e._zod.def, {
    get shape() {
      const i = {};
      for (const s in t) {
        if (!(s in r.shape))
          throw new Error(`Unrecognized key: "${s}"`);
        t[s] && (i[s] = r.shape[s]);
      }
      return Gt(this, "shape", i), i;
    },
    checks: []
  });
  return Ot(e, a);
}
function ku(e, t) {
  const r = e._zod.def, n = r.checks;
  if (n && n.length > 0)
    throw new Error(".omit() cannot be used on object schemas containing refinements");
  const a = Vt(e._zod.def, {
    get shape() {
      const i = { ...e._zod.def.shape };
      for (const s in t) {
        if (!(s in r.shape))
          throw new Error(`Unrecognized key: "${s}"`);
        t[s] && delete i[s];
      }
      return Gt(this, "shape", i), i;
    },
    checks: []
  });
  return Ot(e, a);
}
function wu(e, t) {
  if (!cr(t))
    throw new Error("Invalid input to extend: expected a plain object");
  const r = e._zod.def.checks;
  if (r && r.length > 0) {
    const a = e._zod.def.shape;
    for (const i in t)
      if (Object.getOwnPropertyDescriptor(a, i) !== void 0)
        throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
  }
  const o = Vt(e._zod.def, {
    get shape() {
      const a = { ...e._zod.def.shape, ...t };
      return Gt(this, "shape", a), a;
    }
  });
  return Ot(e, o);
}
function Iu(e, t) {
  if (!cr(t))
    throw new Error("Invalid input to safeExtend: expected a plain object");
  const r = Vt(e._zod.def, {
    get shape() {
      const n = { ...e._zod.def.shape, ...t };
      return Gt(this, "shape", n), n;
    }
  });
  return Ot(e, r);
}
function Su(e, t) {
  const r = Vt(e._zod.def, {
    get shape() {
      const n = { ...e._zod.def.shape, ...t._zod.def.shape };
      return Gt(this, "shape", n), n;
    },
    get catchall() {
      return t._zod.def.catchall;
    },
    checks: []
    // delete existing checks
  });
  return Ot(e, r);
}
function xu(e, t, r) {
  const o = t._zod.def.checks;
  if (o && o.length > 0)
    throw new Error(".partial() cannot be used on object schemas containing refinements");
  const i = Vt(t._zod.def, {
    get shape() {
      const s = t._zod.def.shape, d = { ...s };
      if (r)
        for (const m in r) {
          if (!(m in s))
            throw new Error(`Unrecognized key: "${m}"`);
          r[m] && (d[m] = e ? new e({
            type: "optional",
            innerType: s[m]
          }) : s[m]);
        }
      else
        for (const m in s)
          d[m] = e ? new e({
            type: "optional",
            innerType: s[m]
          }) : s[m];
      return Gt(this, "shape", d), d;
    },
    checks: []
  });
  return Ot(t, i);
}
function Eu(e, t, r) {
  const n = Vt(t._zod.def, {
    get shape() {
      const o = t._zod.def.shape, a = { ...o };
      if (r)
        for (const i in r) {
          if (!(i in a))
            throw new Error(`Unrecognized key: "${i}"`);
          r[i] && (a[i] = new e({
            type: "nonoptional",
            innerType: o[i]
          }));
        }
      else
        for (const i in o)
          a[i] = new e({
            type: "nonoptional",
            innerType: o[i]
          });
      return Gt(this, "shape", a), a;
    }
  });
  return Ot(t, n);
}
function nr(e, t = 0) {
  if (e.aborted === !0)
    return !0;
  for (let r = t; r < e.issues.length; r++)
    if (e.issues[r]?.continue !== !0)
      return !0;
  return !1;
}
function Lt(e, t) {
  return t.map((r) => {
    var n;
    return (n = r).path ?? (n.path = []), r.path.unshift(e), r;
  });
}
function tn(e) {
  return typeof e == "string" ? e : e?.message;
}
function Rt(e, t, r) {
  const n = { ...e, path: e.path ?? [] };
  if (!e.message) {
    const o = tn(e.inst?._zod.def?.error?.(e)) ?? tn(t?.error?.(e)) ?? tn(r.customError?.(e)) ?? tn(r.localeError?.(e)) ?? "Invalid input";
    n.message = o;
  }
  return delete n.inst, delete n.continue, t?.reportInput || delete n.input, n;
}
function Zo(e) {
  return Array.isArray(e) ? "array" : typeof e == "string" ? "string" : "unknown";
}
function Br(...e) {
  const [t, r, n] = e;
  return typeof t == "string" ? {
    message: t,
    code: "custom",
    input: r,
    inst: n
  } : { ...t };
}
const Ts = (e, t) => {
  e.name = "$ZodError", Object.defineProperty(e, "_zod", {
    value: e._zod,
    enumerable: !1
  }), Object.defineProperty(e, "issues", {
    value: t,
    enumerable: !1
  }), e.message = JSON.stringify(t, vo, 2), Object.defineProperty(e, "toString", {
    value: () => e.message,
    enumerable: !1
  });
}, Rs = E("$ZodError", Ts), Cs = E("$ZodError", Ts, { Parent: Error });
function Pu(e, t = (r) => r.message) {
  const r = {}, n = [];
  for (const o of e.issues)
    o.path.length > 0 ? (r[o.path[0]] = r[o.path[0]] || [], r[o.path[0]].push(t(o))) : n.push(t(o));
  return { formErrors: n, fieldErrors: r };
}
function Au(e, t = (r) => r.message) {
  const r = { _errors: [] }, n = (o) => {
    for (const a of o.issues)
      if (a.code === "invalid_union" && a.errors.length)
        a.errors.map((i) => n({ issues: i }));
      else if (a.code === "invalid_key")
        n({ issues: a.issues });
      else if (a.code === "invalid_element")
        n({ issues: a.issues });
      else if (a.path.length === 0)
        r._errors.push(t(a));
      else {
        let i = r, s = 0;
        for (; s < a.path.length; ) {
          const d = a.path[s];
          s === a.path.length - 1 ? (i[d] = i[d] || { _errors: [] }, i[d]._errors.push(t(a))) : i[d] = i[d] || { _errors: [] }, i = i[d], s++;
        }
      }
  };
  return n(e), r;
}
const jo = (e) => (t, r, n, o) => {
  const a = n ? Object.assign(n, { async: !1 }) : { async: !1 }, i = t._zod.run({ value: r, issues: [] }, a);
  if (i instanceof Promise)
    throw new ir();
  if (i.issues.length) {
    const s = new (o?.Err ?? e)(i.issues.map((d) => Rt(d, a, Tt())));
    throw _s(s, o?.callee), s;
  }
  return i.value;
}, Ko = (e) => async (t, r, n, o) => {
  const a = n ? Object.assign(n, { async: !0 }) : { async: !0 };
  let i = t._zod.run({ value: r, issues: [] }, a);
  if (i instanceof Promise && (i = await i), i.issues.length) {
    const s = new (o?.Err ?? e)(i.issues.map((d) => Rt(d, a, Tt())));
    throw _s(s, o?.callee), s;
  }
  return i.value;
}, Cn = (e) => (t, r, n) => {
  const o = n ? { ...n, async: !1 } : { async: !1 }, a = t._zod.run({ value: r, issues: [] }, o);
  if (a instanceof Promise)
    throw new ir();
  return a.issues.length ? {
    success: !1,
    error: new (e ?? Rs)(a.issues.map((i) => Rt(i, o, Tt())))
  } : { success: !0, data: a.value };
}, _u = /* @__PURE__ */ Cn(Cs), Mn = (e) => async (t, r, n) => {
  const o = n ? Object.assign(n, { async: !0 }) : { async: !0 };
  let a = t._zod.run({ value: r, issues: [] }, o);
  return a instanceof Promise && (a = await a), a.issues.length ? {
    success: !1,
    error: new e(a.issues.map((i) => Rt(i, o, Tt())))
  } : { success: !0, data: a.value };
}, zu = /* @__PURE__ */ Mn(Cs), Tu = (e) => (t, r, n) => {
  const o = n ? Object.assign(n, { direction: "backward" }) : { direction: "backward" };
  return jo(e)(t, r, o);
}, Ru = (e) => (t, r, n) => jo(e)(t, r, n), Cu = (e) => async (t, r, n) => {
  const o = n ? Object.assign(n, { direction: "backward" }) : { direction: "backward" };
  return Ko(e)(t, r, o);
}, Mu = (e) => async (t, r, n) => Ko(e)(t, r, n), Du = (e) => (t, r, n) => {
  const o = n ? Object.assign(n, { direction: "backward" }) : { direction: "backward" };
  return Cn(e)(t, r, o);
}, Vu = (e) => (t, r, n) => Cn(e)(t, r, n), Ou = (e) => async (t, r, n) => {
  const o = n ? Object.assign(n, { direction: "backward" }) : { direction: "backward" };
  return Mn(e)(t, r, o);
}, Bu = (e) => async (t, r, n) => Mn(e)(t, r, n), Fu = /^[cC][^\s-]{8,}$/, Nu = /^[0-9a-z]+$/, $u = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/, qu = /^[0-9a-vA-V]{20}$/, Hu = /^[A-Za-z0-9]{27}$/, Lu = /^[a-zA-Z0-9_-]{21}$/, Uu = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/, Zu = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/, Xa = (e) => e ? new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${e}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`) : /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/, ju = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/, Ku = "^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$";
function Wu() {
  return new RegExp(Ku, "u");
}
const Gu = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/, Qu = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/, Ju = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/, Xu = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/, Yu = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/, Ms = /^[A-Za-z0-9_-]*$/, ep = /^\+[1-9]\d{6,14}$/, Ds = "(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))", tp = /* @__PURE__ */ new RegExp(`^${Ds}$`);
function Vs(e) {
  const t = "(?:[01]\\d|2[0-3]):[0-5]\\d";
  return typeof e.precision == "number" ? e.precision === -1 ? `${t}` : e.precision === 0 ? `${t}:[0-5]\\d` : `${t}:[0-5]\\d\\.\\d{${e.precision}}` : `${t}(?::[0-5]\\d(?:\\.\\d+)?)?`;
}
function rp(e) {
  return new RegExp(`^${Vs(e)}$`);
}
function np(e) {
  const t = Vs({ precision: e.precision }), r = ["Z"];
  e.local && r.push(""), e.offset && r.push("([+-](?:[01]\\d|2[0-3]):[0-5]\\d)");
  const n = `${t}(?:${r.join("|")})`;
  return new RegExp(`^${Ds}T(?:${n})$`);
}
const op = (e) => {
  const t = e ? `[\\s\\S]{${e?.minimum ?? 0},${e?.maximum ?? ""}}` : "[\\s\\S]*";
  return new RegExp(`^${t}$`);
}, ap = /^-?\d+$/, Os = /^-?\d+(?:\.\d+)?$/, ip = /^(?:true|false)$/i, sp = /^[^A-Z]*$/, cp = /^[^a-z]*$/, Fe = /* @__PURE__ */ E("$ZodCheck", (e, t) => {
  var r;
  e._zod ?? (e._zod = {}), e._zod.def = t, (r = e._zod).onattach ?? (r.onattach = []);
}), Bs = {
  number: "number",
  bigint: "bigint",
  object: "date"
}, Fs = /* @__PURE__ */ E("$ZodCheckLessThan", (e, t) => {
  Fe.init(e, t);
  const r = Bs[typeof t.value];
  e._zod.onattach.push((n) => {
    const o = n._zod.bag, a = (t.inclusive ? o.maximum : o.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
    t.value < a && (t.inclusive ? o.maximum = t.value : o.exclusiveMaximum = t.value);
  }), e._zod.check = (n) => {
    (t.inclusive ? n.value <= t.value : n.value < t.value) || n.issues.push({
      origin: r,
      code: "too_big",
      maximum: typeof t.value == "object" ? t.value.getTime() : t.value,
      input: n.value,
      inclusive: t.inclusive,
      inst: e,
      continue: !t.abort
    });
  };
}), Ns = /* @__PURE__ */ E("$ZodCheckGreaterThan", (e, t) => {
  Fe.init(e, t);
  const r = Bs[typeof t.value];
  e._zod.onattach.push((n) => {
    const o = n._zod.bag, a = (t.inclusive ? o.minimum : o.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
    t.value > a && (t.inclusive ? o.minimum = t.value : o.exclusiveMinimum = t.value);
  }), e._zod.check = (n) => {
    (t.inclusive ? n.value >= t.value : n.value > t.value) || n.issues.push({
      origin: r,
      code: "too_small",
      minimum: typeof t.value == "object" ? t.value.getTime() : t.value,
      input: n.value,
      inclusive: t.inclusive,
      inst: e,
      continue: !t.abort
    });
  };
}), dp = /* @__PURE__ */ E("$ZodCheckMultipleOf", (e, t) => {
  Fe.init(e, t), e._zod.onattach.push((r) => {
    var n;
    (n = r._zod.bag).multipleOf ?? (n.multipleOf = t.value);
  }), e._zod.check = (r) => {
    if (typeof r.value != typeof t.value)
      throw new Error("Cannot mix number and bigint in multiple_of check.");
    (typeof r.value == "bigint" ? r.value % t.value === BigInt(0) : mu(r.value, t.value) === 0) || r.issues.push({
      origin: typeof r.value,
      code: "not_multiple_of",
      divisor: t.value,
      input: r.value,
      inst: e,
      continue: !t.abort
    });
  };
}), lp = /* @__PURE__ */ E("$ZodCheckNumberFormat", (e, t) => {
  Fe.init(e, t), t.format = t.format || "float64";
  const r = t.format?.includes("int"), n = r ? "int" : "number", [o, a] = bu[t.format];
  e._zod.onattach.push((i) => {
    const s = i._zod.bag;
    s.format = t.format, s.minimum = o, s.maximum = a, r && (s.pattern = ap);
  }), e._zod.check = (i) => {
    const s = i.value;
    if (r) {
      if (!Number.isInteger(s)) {
        i.issues.push({
          expected: n,
          format: t.format,
          code: "invalid_type",
          continue: !1,
          input: s,
          inst: e
        });
        return;
      }
      if (!Number.isSafeInteger(s)) {
        s > 0 ? i.issues.push({
          input: s,
          code: "too_big",
          maximum: Number.MAX_SAFE_INTEGER,
          note: "Integers must be within the safe integer range.",
          inst: e,
          origin: n,
          inclusive: !0,
          continue: !t.abort
        }) : i.issues.push({
          input: s,
          code: "too_small",
          minimum: Number.MIN_SAFE_INTEGER,
          note: "Integers must be within the safe integer range.",
          inst: e,
          origin: n,
          inclusive: !0,
          continue: !t.abort
        });
        return;
      }
    }
    s < o && i.issues.push({
      origin: "number",
      input: s,
      code: "too_small",
      minimum: o,
      inclusive: !0,
      inst: e,
      continue: !t.abort
    }), s > a && i.issues.push({
      origin: "number",
      input: s,
      code: "too_big",
      maximum: a,
      inclusive: !0,
      inst: e,
      continue: !t.abort
    });
  };
}), up = /* @__PURE__ */ E("$ZodCheckMaxLength", (e, t) => {
  var r;
  Fe.init(e, t), (r = e._zod.def).when ?? (r.when = (n) => {
    const o = n.value;
    return !Lo(o) && o.length !== void 0;
  }), e._zod.onattach.push((n) => {
    const o = n._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    t.maximum < o && (n._zod.bag.maximum = t.maximum);
  }), e._zod.check = (n) => {
    const o = n.value;
    if (o.length <= t.maximum)
      return;
    const i = Zo(o);
    n.issues.push({
      origin: i,
      code: "too_big",
      maximum: t.maximum,
      inclusive: !0,
      input: o,
      inst: e,
      continue: !t.abort
    });
  };
}), pp = /* @__PURE__ */ E("$ZodCheckMinLength", (e, t) => {
  var r;
  Fe.init(e, t), (r = e._zod.def).when ?? (r.when = (n) => {
    const o = n.value;
    return !Lo(o) && o.length !== void 0;
  }), e._zod.onattach.push((n) => {
    const o = n._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    t.minimum > o && (n._zod.bag.minimum = t.minimum);
  }), e._zod.check = (n) => {
    const o = n.value;
    if (o.length >= t.minimum)
      return;
    const i = Zo(o);
    n.issues.push({
      origin: i,
      code: "too_small",
      minimum: t.minimum,
      inclusive: !0,
      input: o,
      inst: e,
      continue: !t.abort
    });
  };
}), mp = /* @__PURE__ */ E("$ZodCheckLengthEquals", (e, t) => {
  var r;
  Fe.init(e, t), (r = e._zod.def).when ?? (r.when = (n) => {
    const o = n.value;
    return !Lo(o) && o.length !== void 0;
  }), e._zod.onattach.push((n) => {
    const o = n._zod.bag;
    o.minimum = t.length, o.maximum = t.length, o.length = t.length;
  }), e._zod.check = (n) => {
    const o = n.value, a = o.length;
    if (a === t.length)
      return;
    const i = Zo(o), s = a > t.length;
    n.issues.push({
      origin: i,
      ...s ? { code: "too_big", maximum: t.length } : { code: "too_small", minimum: t.length },
      inclusive: !0,
      exact: !0,
      input: n.value,
      inst: e,
      continue: !t.abort
    });
  };
}), Dn = /* @__PURE__ */ E("$ZodCheckStringFormat", (e, t) => {
  var r, n;
  Fe.init(e, t), e._zod.onattach.push((o) => {
    const a = o._zod.bag;
    a.format = t.format, t.pattern && (a.patterns ?? (a.patterns = /* @__PURE__ */ new Set()), a.patterns.add(t.pattern));
  }), t.pattern ? (r = e._zod).check ?? (r.check = (o) => {
    t.pattern.lastIndex = 0, !t.pattern.test(o.value) && o.issues.push({
      origin: "string",
      code: "invalid_format",
      format: t.format,
      input: o.value,
      ...t.pattern ? { pattern: t.pattern.toString() } : {},
      inst: e,
      continue: !t.abort
    });
  }) : (n = e._zod).check ?? (n.check = () => {
  });
}), fp = /* @__PURE__ */ E("$ZodCheckRegex", (e, t) => {
  Dn.init(e, t), e._zod.check = (r) => {
    t.pattern.lastIndex = 0, !t.pattern.test(r.value) && r.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "regex",
      input: r.value,
      pattern: t.pattern.toString(),
      inst: e,
      continue: !t.abort
    });
  };
}), hp = /* @__PURE__ */ E("$ZodCheckLowerCase", (e, t) => {
  t.pattern ?? (t.pattern = sp), Dn.init(e, t);
}), gp = /* @__PURE__ */ E("$ZodCheckUpperCase", (e, t) => {
  t.pattern ?? (t.pattern = cp), Dn.init(e, t);
}), yp = /* @__PURE__ */ E("$ZodCheckIncludes", (e, t) => {
  Fe.init(e, t);
  const r = dr(t.includes), n = new RegExp(typeof t.position == "number" ? `^.{${t.position}}${r}` : r);
  t.pattern = n, e._zod.onattach.push((o) => {
    const a = o._zod.bag;
    a.patterns ?? (a.patterns = /* @__PURE__ */ new Set()), a.patterns.add(n);
  }), e._zod.check = (o) => {
    o.value.includes(t.includes, t.position) || o.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "includes",
      includes: t.includes,
      input: o.value,
      inst: e,
      continue: !t.abort
    });
  };
}), bp = /* @__PURE__ */ E("$ZodCheckStartsWith", (e, t) => {
  Fe.init(e, t);
  const r = new RegExp(`^${dr(t.prefix)}.*`);
  t.pattern ?? (t.pattern = r), e._zod.onattach.push((n) => {
    const o = n._zod.bag;
    o.patterns ?? (o.patterns = /* @__PURE__ */ new Set()), o.patterns.add(r);
  }), e._zod.check = (n) => {
    n.value.startsWith(t.prefix) || n.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "starts_with",
      prefix: t.prefix,
      input: n.value,
      inst: e,
      continue: !t.abort
    });
  };
}), vp = /* @__PURE__ */ E("$ZodCheckEndsWith", (e, t) => {
  Fe.init(e, t);
  const r = new RegExp(`.*${dr(t.suffix)}$`);
  t.pattern ?? (t.pattern = r), e._zod.onattach.push((n) => {
    const o = n._zod.bag;
    o.patterns ?? (o.patterns = /* @__PURE__ */ new Set()), o.patterns.add(r);
  }), e._zod.check = (n) => {
    n.value.endsWith(t.suffix) || n.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "ends_with",
      suffix: t.suffix,
      input: n.value,
      inst: e,
      continue: !t.abort
    });
  };
}), kp = /* @__PURE__ */ E("$ZodCheckOverwrite", (e, t) => {
  Fe.init(e, t), e._zod.check = (r) => {
    r.value = t.tx(r.value);
  };
});
class wp {
  constructor(t = []) {
    this.content = [], this.indent = 0, this && (this.args = t);
  }
  indented(t) {
    this.indent += 1, t(this), this.indent -= 1;
  }
  write(t) {
    if (typeof t == "function") {
      t(this, { execution: "sync" }), t(this, { execution: "async" });
      return;
    }
    const n = t.split(`
`).filter((i) => i), o = Math.min(...n.map((i) => i.length - i.trimStart().length)), a = n.map((i) => i.slice(o)).map((i) => " ".repeat(this.indent * 2) + i);
    for (const i of a)
      this.content.push(i);
  }
  compile() {
    const t = Function, r = this?.args, o = [...(this?.content ?? [""]).map((a) => `  ${a}`)];
    return new t(...r, o.join(`
`));
  }
}
const Ip = {
  major: 4,
  minor: 3,
  patch: 6
}, le = /* @__PURE__ */ E("$ZodType", (e, t) => {
  var r;
  e ?? (e = {}), e._zod.def = t, e._zod.bag = e._zod.bag || {}, e._zod.version = Ip;
  const n = [...e._zod.def.checks ?? []];
  e._zod.traits.has("$ZodCheck") && n.unshift(e);
  for (const o of n)
    for (const a of o._zod.onattach)
      a(e);
  if (n.length === 0)
    (r = e._zod).deferred ?? (r.deferred = []), e._zod.deferred?.push(() => {
      e._zod.run = e._zod.parse;
    });
  else {
    const o = (i, s, d) => {
      let m = nr(i), h;
      for (const g of s) {
        if (g._zod.def.when) {
          if (!g._zod.def.when(i))
            continue;
        } else if (m)
          continue;
        const S = i.issues.length, _ = g._zod.check(i);
        if (_ instanceof Promise && d?.async === !1)
          throw new ir();
        if (h || _ instanceof Promise)
          h = (h ?? Promise.resolve()).then(async () => {
            await _, i.issues.length !== S && (m || (m = nr(i, S)));
          });
        else {
          if (i.issues.length === S)
            continue;
          m || (m = nr(i, S));
        }
      }
      return h ? h.then(() => i) : i;
    }, a = (i, s, d) => {
      if (nr(i))
        return i.aborted = !0, i;
      const m = o(s, n, d);
      if (m instanceof Promise) {
        if (d.async === !1)
          throw new ir();
        return m.then((h) => e._zod.parse(h, d));
      }
      return e._zod.parse(m, d);
    };
    e._zod.run = (i, s) => {
      if (s.skipChecks)
        return e._zod.parse(i, s);
      if (s.direction === "backward") {
        const m = e._zod.parse({ value: i.value, issues: [] }, { ...s, skipChecks: !0 });
        return m instanceof Promise ? m.then((h) => a(h, i, s)) : a(m, i, s);
      }
      const d = e._zod.parse(i, s);
      if (d instanceof Promise) {
        if (s.async === !1)
          throw new ir();
        return d.then((m) => o(m, n, s));
      }
      return o(d, n, s);
    };
  }
  ne(e, "~standard", () => ({
    validate: (o) => {
      try {
        const a = _u(e, o);
        return a.success ? { value: a.data } : { issues: a.error?.issues };
      } catch {
        return zu(e, o).then((i) => i.success ? { value: i.data } : { issues: i.error?.issues });
      }
    },
    vendor: "zod",
    version: 1
  }));
}), Wo = /* @__PURE__ */ E("$ZodString", (e, t) => {
  le.init(e, t), e._zod.pattern = [...e?._zod.bag?.patterns ?? []].pop() ?? op(e._zod.bag), e._zod.parse = (r, n) => {
    if (t.coerce)
      try {
        r.value = String(r.value);
      } catch {
      }
    return typeof r.value == "string" || r.issues.push({
      expected: "string",
      code: "invalid_type",
      input: r.value,
      inst: e
    }), r;
  };
}), he = /* @__PURE__ */ E("$ZodStringFormat", (e, t) => {
  Dn.init(e, t), Wo.init(e, t);
}), Sp = /* @__PURE__ */ E("$ZodGUID", (e, t) => {
  t.pattern ?? (t.pattern = Zu), he.init(e, t);
}), xp = /* @__PURE__ */ E("$ZodUUID", (e, t) => {
  if (t.version) {
    const n = {
      v1: 1,
      v2: 2,
      v3: 3,
      v4: 4,
      v5: 5,
      v6: 6,
      v7: 7,
      v8: 8
    }[t.version];
    if (n === void 0)
      throw new Error(`Invalid UUID version: "${t.version}"`);
    t.pattern ?? (t.pattern = Xa(n));
  } else
    t.pattern ?? (t.pattern = Xa());
  he.init(e, t);
}), Ep = /* @__PURE__ */ E("$ZodEmail", (e, t) => {
  t.pattern ?? (t.pattern = ju), he.init(e, t);
}), Pp = /* @__PURE__ */ E("$ZodURL", (e, t) => {
  he.init(e, t), e._zod.check = (r) => {
    try {
      const n = r.value.trim(), o = new URL(n);
      t.hostname && (t.hostname.lastIndex = 0, t.hostname.test(o.hostname) || r.issues.push({
        code: "invalid_format",
        format: "url",
        note: "Invalid hostname",
        pattern: t.hostname.source,
        input: r.value,
        inst: e,
        continue: !t.abort
      })), t.protocol && (t.protocol.lastIndex = 0, t.protocol.test(o.protocol.endsWith(":") ? o.protocol.slice(0, -1) : o.protocol) || r.issues.push({
        code: "invalid_format",
        format: "url",
        note: "Invalid protocol",
        pattern: t.protocol.source,
        input: r.value,
        inst: e,
        continue: !t.abort
      })), t.normalize ? r.value = o.href : r.value = n;
      return;
    } catch {
      r.issues.push({
        code: "invalid_format",
        format: "url",
        input: r.value,
        inst: e,
        continue: !t.abort
      });
    }
  };
}), Ap = /* @__PURE__ */ E("$ZodEmoji", (e, t) => {
  t.pattern ?? (t.pattern = Wu()), he.init(e, t);
}), _p = /* @__PURE__ */ E("$ZodNanoID", (e, t) => {
  t.pattern ?? (t.pattern = Lu), he.init(e, t);
}), zp = /* @__PURE__ */ E("$ZodCUID", (e, t) => {
  t.pattern ?? (t.pattern = Fu), he.init(e, t);
}), Tp = /* @__PURE__ */ E("$ZodCUID2", (e, t) => {
  t.pattern ?? (t.pattern = Nu), he.init(e, t);
}), Rp = /* @__PURE__ */ E("$ZodULID", (e, t) => {
  t.pattern ?? (t.pattern = $u), he.init(e, t);
}), Cp = /* @__PURE__ */ E("$ZodXID", (e, t) => {
  t.pattern ?? (t.pattern = qu), he.init(e, t);
}), Mp = /* @__PURE__ */ E("$ZodKSUID", (e, t) => {
  t.pattern ?? (t.pattern = Hu), he.init(e, t);
}), Dp = /* @__PURE__ */ E("$ZodISODateTime", (e, t) => {
  t.pattern ?? (t.pattern = np(t)), he.init(e, t);
}), Vp = /* @__PURE__ */ E("$ZodISODate", (e, t) => {
  t.pattern ?? (t.pattern = tp), he.init(e, t);
}), Op = /* @__PURE__ */ E("$ZodISOTime", (e, t) => {
  t.pattern ?? (t.pattern = rp(t)), he.init(e, t);
}), Bp = /* @__PURE__ */ E("$ZodISODuration", (e, t) => {
  t.pattern ?? (t.pattern = Uu), he.init(e, t);
}), Fp = /* @__PURE__ */ E("$ZodIPv4", (e, t) => {
  t.pattern ?? (t.pattern = Gu), he.init(e, t), e._zod.bag.format = "ipv4";
}), Np = /* @__PURE__ */ E("$ZodIPv6", (e, t) => {
  t.pattern ?? (t.pattern = Qu), he.init(e, t), e._zod.bag.format = "ipv6", e._zod.check = (r) => {
    try {
      new URL(`http://[${r.value}]`);
    } catch {
      r.issues.push({
        code: "invalid_format",
        format: "ipv6",
        input: r.value,
        inst: e,
        continue: !t.abort
      });
    }
  };
}), $p = /* @__PURE__ */ E("$ZodCIDRv4", (e, t) => {
  t.pattern ?? (t.pattern = Ju), he.init(e, t);
}), qp = /* @__PURE__ */ E("$ZodCIDRv6", (e, t) => {
  t.pattern ?? (t.pattern = Xu), he.init(e, t), e._zod.check = (r) => {
    const n = r.value.split("/");
    try {
      if (n.length !== 2)
        throw new Error();
      const [o, a] = n;
      if (!a)
        throw new Error();
      const i = Number(a);
      if (`${i}` !== a)
        throw new Error();
      if (i < 0 || i > 128)
        throw new Error();
      new URL(`http://[${o}]`);
    } catch {
      r.issues.push({
        code: "invalid_format",
        format: "cidrv6",
        input: r.value,
        inst: e,
        continue: !t.abort
      });
    }
  };
});
function $s(e) {
  if (e === "")
    return !0;
  if (e.length % 4 !== 0)
    return !1;
  try {
    return atob(e), !0;
  } catch {
    return !1;
  }
}
const Hp = /* @__PURE__ */ E("$ZodBase64", (e, t) => {
  t.pattern ?? (t.pattern = Yu), he.init(e, t), e._zod.bag.contentEncoding = "base64", e._zod.check = (r) => {
    $s(r.value) || r.issues.push({
      code: "invalid_format",
      format: "base64",
      input: r.value,
      inst: e,
      continue: !t.abort
    });
  };
});
function Lp(e) {
  if (!Ms.test(e))
    return !1;
  const t = e.replace(/[-_]/g, (n) => n === "-" ? "+" : "/"), r = t.padEnd(Math.ceil(t.length / 4) * 4, "=");
  return $s(r);
}
const Up = /* @__PURE__ */ E("$ZodBase64URL", (e, t) => {
  t.pattern ?? (t.pattern = Ms), he.init(e, t), e._zod.bag.contentEncoding = "base64url", e._zod.check = (r) => {
    Lp(r.value) || r.issues.push({
      code: "invalid_format",
      format: "base64url",
      input: r.value,
      inst: e,
      continue: !t.abort
    });
  };
}), Zp = /* @__PURE__ */ E("$ZodE164", (e, t) => {
  t.pattern ?? (t.pattern = ep), he.init(e, t);
});
function jp(e, t = null) {
  try {
    const r = e.split(".");
    if (r.length !== 3)
      return !1;
    const [n] = r;
    if (!n)
      return !1;
    const o = JSON.parse(atob(n));
    return !("typ" in o && o?.typ !== "JWT" || !o.alg || t && (!("alg" in o) || o.alg !== t));
  } catch {
    return !1;
  }
}
const Kp = /* @__PURE__ */ E("$ZodJWT", (e, t) => {
  he.init(e, t), e._zod.check = (r) => {
    jp(r.value, t.alg) || r.issues.push({
      code: "invalid_format",
      format: "jwt",
      input: r.value,
      inst: e,
      continue: !t.abort
    });
  };
}), qs = /* @__PURE__ */ E("$ZodNumber", (e, t) => {
  le.init(e, t), e._zod.pattern = e._zod.bag.pattern ?? Os, e._zod.parse = (r, n) => {
    if (t.coerce)
      try {
        r.value = Number(r.value);
      } catch {
      }
    const o = r.value;
    if (typeof o == "number" && !Number.isNaN(o) && Number.isFinite(o))
      return r;
    const a = typeof o == "number" ? Number.isNaN(o) ? "NaN" : Number.isFinite(o) ? void 0 : "Infinity" : void 0;
    return r.issues.push({
      expected: "number",
      code: "invalid_type",
      input: o,
      inst: e,
      ...a ? { received: a } : {}
    }), r;
  };
}), Wp = /* @__PURE__ */ E("$ZodNumberFormat", (e, t) => {
  lp.init(e, t), qs.init(e, t);
}), Gp = /* @__PURE__ */ E("$ZodBoolean", (e, t) => {
  le.init(e, t), e._zod.pattern = ip, e._zod.parse = (r, n) => {
    if (t.coerce)
      try {
        r.value = !!r.value;
      } catch {
      }
    const o = r.value;
    return typeof o == "boolean" || r.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input: o,
      inst: e
    }), r;
  };
}), Qp = /* @__PURE__ */ E("$ZodUnknown", (e, t) => {
  le.init(e, t), e._zod.parse = (r) => r;
}), Jp = /* @__PURE__ */ E("$ZodNever", (e, t) => {
  le.init(e, t), e._zod.parse = (r, n) => (r.issues.push({
    expected: "never",
    code: "invalid_type",
    input: r.value,
    inst: e
  }), r);
});
function Ya(e, t, r) {
  e.issues.length && t.issues.push(...Lt(r, e.issues)), t.value[r] = e.value;
}
const Xp = /* @__PURE__ */ E("$ZodArray", (e, t) => {
  le.init(e, t), e._zod.parse = (r, n) => {
    const o = r.value;
    if (!Array.isArray(o))
      return r.issues.push({
        expected: "array",
        code: "invalid_type",
        input: o,
        inst: e
      }), r;
    r.value = Array(o.length);
    const a = [];
    for (let i = 0; i < o.length; i++) {
      const s = o[i], d = t.element._zod.run({
        value: s,
        issues: []
      }, n);
      d instanceof Promise ? a.push(d.then((m) => Ya(m, r, i))) : Ya(d, r, i);
    }
    return a.length ? Promise.all(a).then(() => r) : r;
  };
});
function un(e, t, r, n, o) {
  if (e.issues.length) {
    if (o && !(r in n))
      return;
    t.issues.push(...Lt(r, e.issues));
  }
  e.value === void 0 ? r in n && (t.value[r] = void 0) : t.value[r] = e.value;
}
function Hs(e) {
  const t = Object.keys(e.shape);
  for (const n of t)
    if (!e.shape?.[n]?._zod?.traits?.has("$ZodType"))
      throw new Error(`Invalid element at key "${n}": expected a Zod schema`);
  const r = yu(e.shape);
  return {
    ...e,
    keys: t,
    keySet: new Set(t),
    numKeys: t.length,
    optionalKeys: new Set(r)
  };
}
function Ls(e, t, r, n, o, a) {
  const i = [], s = o.keySet, d = o.catchall._zod, m = d.def.type, h = d.optout === "optional";
  for (const g in t) {
    if (s.has(g))
      continue;
    if (m === "never") {
      i.push(g);
      continue;
    }
    const S = d.run({ value: t[g], issues: [] }, n);
    S instanceof Promise ? e.push(S.then((_) => un(_, r, g, t, h))) : un(S, r, g, t, h);
  }
  return i.length && r.issues.push({
    code: "unrecognized_keys",
    keys: i,
    input: t,
    inst: a
  }), e.length ? Promise.all(e).then(() => r) : r;
}
const Yp = /* @__PURE__ */ E("$ZodObject", (e, t) => {
  if (le.init(e, t), !Object.getOwnPropertyDescriptor(t, "shape")?.get) {
    const s = t.shape;
    Object.defineProperty(t, "shape", {
      get: () => {
        const d = { ...s };
        return Object.defineProperty(t, "shape", {
          value: d
        }), d;
      }
    });
  }
  const n = Rn(() => Hs(t));
  ne(e._zod, "propValues", () => {
    const s = t.shape, d = {};
    for (const m in s) {
      const h = s[m]._zod;
      if (h.values) {
        d[m] ?? (d[m] = /* @__PURE__ */ new Set());
        for (const g of h.values)
          d[m].add(g);
      }
    }
    return d;
  });
  const o = Or, a = t.catchall;
  let i;
  e._zod.parse = (s, d) => {
    i ?? (i = n.value);
    const m = s.value;
    if (!o(m))
      return s.issues.push({
        expected: "object",
        code: "invalid_type",
        input: m,
        inst: e
      }), s;
    s.value = {};
    const h = [], g = i.shape;
    for (const S of i.keys) {
      const _ = g[S], H = _._zod.optout === "optional", q = _._zod.run({ value: m[S], issues: [] }, d);
      q instanceof Promise ? h.push(q.then((u) => un(u, s, S, m, H))) : un(q, s, S, m, H);
    }
    return a ? Ls(h, m, s, d, n.value, e) : h.length ? Promise.all(h).then(() => s) : s;
  };
}), em = /* @__PURE__ */ E("$ZodObjectJIT", (e, t) => {
  Yp.init(e, t);
  const r = e._zod.parse, n = Rn(() => Hs(t)), o = (S) => {
    const _ = new wp(["shape", "payload", "ctx"]), H = n.value, q = (C) => {
      const L = Ja(C);
      return `shape[${L}]._zod.run({ value: input[${L}], issues: [] }, ctx)`;
    };
    _.write("const input = payload.value;");
    const u = /* @__PURE__ */ Object.create(null);
    let p = 0;
    for (const C of H.keys)
      u[C] = `key_${p++}`;
    _.write("const newResult = {};");
    for (const C of H.keys) {
      const L = u[C], K = Ja(C), qe = S[C]?._zod?.optout === "optional";
      _.write(`const ${L} = ${q(C)};`), qe ? _.write(`
        if (${L}.issues.length) {
          if (${K} in input) {
            payload.issues = payload.issues.concat(${L}.issues.map(iss => ({
              ...iss,
              path: iss.path ? [${K}, ...iss.path] : [${K}]
            })));
          }
        }
        
        if (${L}.value === undefined) {
          if (${K} in input) {
            newResult[${K}] = undefined;
          }
        } else {
          newResult[${K}] = ${L}.value;
        }
        
      `) : _.write(`
        if (${L}.issues.length) {
          payload.issues = payload.issues.concat(${L}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${K}, ...iss.path] : [${K}]
          })));
        }
        
        if (${L}.value === undefined) {
          if (${K} in input) {
            newResult[${K}] = undefined;
          }
        } else {
          newResult[${K}] = ${L}.value;
        }
        
      `);
    }
    _.write("payload.value = newResult;"), _.write("return payload;");
    const A = _.compile();
    return (C, L) => A(S, C, L);
  };
  let a;
  const i = Or, s = !Ps.jitless, m = s && hu.value, h = t.catchall;
  let g;
  e._zod.parse = (S, _) => {
    g ?? (g = n.value);
    const H = S.value;
    return i(H) ? s && m && _?.async === !1 && _.jitless !== !0 ? (a || (a = o(t.shape)), S = a(S, _), h ? Ls([], H, S, _, g, e) : S) : r(S, _) : (S.issues.push({
      expected: "object",
      code: "invalid_type",
      input: H,
      inst: e
    }), S);
  };
});
function ei(e, t, r, n) {
  for (const a of e)
    if (a.issues.length === 0)
      return t.value = a.value, t;
  const o = e.filter((a) => !nr(a));
  return o.length === 1 ? (t.value = o[0].value, o[0]) : (t.issues.push({
    code: "invalid_union",
    input: t.value,
    inst: r,
    errors: e.map((a) => a.issues.map((i) => Rt(i, n, Tt())))
  }), t);
}
const Us = /* @__PURE__ */ E("$ZodUnion", (e, t) => {
  le.init(e, t), ne(e._zod, "optin", () => t.options.some((o) => o._zod.optin === "optional") ? "optional" : void 0), ne(e._zod, "optout", () => t.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0), ne(e._zod, "values", () => {
    if (t.options.every((o) => o._zod.values))
      return new Set(t.options.flatMap((o) => Array.from(o._zod.values)));
  }), ne(e._zod, "pattern", () => {
    if (t.options.every((o) => o._zod.pattern)) {
      const o = t.options.map((a) => a._zod.pattern);
      return new RegExp(`^(${o.map((a) => Uo(a.source)).join("|")})$`);
    }
  });
  const r = t.options.length === 1, n = t.options[0]._zod.run;
  e._zod.parse = (o, a) => {
    if (r)
      return n(o, a);
    let i = !1;
    const s = [];
    for (const d of t.options) {
      const m = d._zod.run({
        value: o.value,
        issues: []
      }, a);
      if (m instanceof Promise)
        s.push(m), i = !0;
      else {
        if (m.issues.length === 0)
          return m;
        s.push(m);
      }
    }
    return i ? Promise.all(s).then((d) => ei(d, o, e, a)) : ei(s, o, e, a);
  };
}), tm = /* @__PURE__ */ E("$ZodDiscriminatedUnion", (e, t) => {
  t.inclusive = !1, Us.init(e, t);
  const r = e._zod.parse;
  ne(e._zod, "propValues", () => {
    const o = {};
    for (const a of t.options) {
      const i = a._zod.propValues;
      if (!i || Object.keys(i).length === 0)
        throw new Error(`Invalid discriminated union option at index "${t.options.indexOf(a)}"`);
      for (const [s, d] of Object.entries(i)) {
        o[s] || (o[s] = /* @__PURE__ */ new Set());
        for (const m of d)
          o[s].add(m);
      }
    }
    return o;
  });
  const n = Rn(() => {
    const o = t.options, a = /* @__PURE__ */ new Map();
    for (const i of o) {
      const s = i._zod.propValues?.[t.discriminator];
      if (!s || s.size === 0)
        throw new Error(`Invalid discriminated union option at index "${t.options.indexOf(i)}"`);
      for (const d of s) {
        if (a.has(d))
          throw new Error(`Duplicate discriminator value "${String(d)}"`);
        a.set(d, i);
      }
    }
    return a;
  });
  e._zod.parse = (o, a) => {
    const i = o.value;
    if (!Or(i))
      return o.issues.push({
        code: "invalid_type",
        expected: "object",
        input: i,
        inst: e
      }), o;
    const s = n.value.get(i?.[t.discriminator]);
    return s ? s._zod.run(o, a) : t.unionFallback ? r(o, a) : (o.issues.push({
      code: "invalid_union",
      errors: [],
      note: "No matching discriminator",
      discriminator: t.discriminator,
      input: i,
      path: [t.discriminator],
      inst: e
    }), o);
  };
}), rm = /* @__PURE__ */ E("$ZodIntersection", (e, t) => {
  le.init(e, t), e._zod.parse = (r, n) => {
    const o = r.value, a = t.left._zod.run({ value: o, issues: [] }, n), i = t.right._zod.run({ value: o, issues: [] }, n);
    return a instanceof Promise || i instanceof Promise ? Promise.all([a, i]).then(([d, m]) => ti(r, d, m)) : ti(r, a, i);
  };
});
function ko(e, t) {
  if (e === t)
    return { valid: !0, data: e };
  if (e instanceof Date && t instanceof Date && +e == +t)
    return { valid: !0, data: e };
  if (cr(e) && cr(t)) {
    const r = Object.keys(t), n = Object.keys(e).filter((a) => r.indexOf(a) !== -1), o = { ...e, ...t };
    for (const a of n) {
      const i = ko(e[a], t[a]);
      if (!i.valid)
        return {
          valid: !1,
          mergeErrorPath: [a, ...i.mergeErrorPath]
        };
      o[a] = i.data;
    }
    return { valid: !0, data: o };
  }
  if (Array.isArray(e) && Array.isArray(t)) {
    if (e.length !== t.length)
      return { valid: !1, mergeErrorPath: [] };
    const r = [];
    for (let n = 0; n < e.length; n++) {
      const o = e[n], a = t[n], i = ko(o, a);
      if (!i.valid)
        return {
          valid: !1,
          mergeErrorPath: [n, ...i.mergeErrorPath]
        };
      r.push(i.data);
    }
    return { valid: !0, data: r };
  }
  return { valid: !1, mergeErrorPath: [] };
}
function ti(e, t, r) {
  const n = /* @__PURE__ */ new Map();
  let o;
  for (const s of t.issues)
    if (s.code === "unrecognized_keys") {
      o ?? (o = s);
      for (const d of s.keys)
        n.has(d) || n.set(d, {}), n.get(d).l = !0;
    } else
      e.issues.push(s);
  for (const s of r.issues)
    if (s.code === "unrecognized_keys")
      for (const d of s.keys)
        n.has(d) || n.set(d, {}), n.get(d).r = !0;
    else
      e.issues.push(s);
  const a = [...n].filter(([, s]) => s.l && s.r).map(([s]) => s);
  if (a.length && o && e.issues.push({ ...o, keys: a }), nr(e))
    return e;
  const i = ko(t.value, r.value);
  if (!i.valid)
    throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(i.mergeErrorPath)}`);
  return e.value = i.data, e;
}
const nm = /* @__PURE__ */ E("$ZodTuple", (e, t) => {
  le.init(e, t);
  const r = t.items;
  e._zod.parse = (n, o) => {
    const a = n.value;
    if (!Array.isArray(a))
      return n.issues.push({
        input: a,
        inst: e,
        expected: "tuple",
        code: "invalid_type"
      }), n;
    n.value = [];
    const i = [], s = [...r].reverse().findIndex((h) => h._zod.optin !== "optional"), d = s === -1 ? 0 : r.length - s;
    if (!t.rest) {
      const h = a.length > r.length, g = a.length < d - 1;
      if (h || g)
        return n.issues.push({
          ...h ? { code: "too_big", maximum: r.length, inclusive: !0 } : { code: "too_small", minimum: r.length },
          input: a,
          inst: e,
          origin: "array"
        }), n;
    }
    let m = -1;
    for (const h of r) {
      if (m++, m >= a.length && m >= d)
        continue;
      const g = h._zod.run({
        value: a[m],
        issues: []
      }, o);
      g instanceof Promise ? i.push(g.then((S) => rn(S, n, m))) : rn(g, n, m);
    }
    if (t.rest) {
      const h = a.slice(r.length);
      for (const g of h) {
        m++;
        const S = t.rest._zod.run({
          value: g,
          issues: []
        }, o);
        S instanceof Promise ? i.push(S.then((_) => rn(_, n, m))) : rn(S, n, m);
      }
    }
    return i.length ? Promise.all(i).then(() => n) : n;
  };
});
function rn(e, t, r) {
  e.issues.length && t.issues.push(...Lt(r, e.issues)), t.value[r] = e.value;
}
const om = /* @__PURE__ */ E("$ZodRecord", (e, t) => {
  le.init(e, t), e._zod.parse = (r, n) => {
    const o = r.value;
    if (!cr(o))
      return r.issues.push({
        expected: "record",
        code: "invalid_type",
        input: o,
        inst: e
      }), r;
    const a = [], i = t.keyType._zod.values;
    if (i) {
      r.value = {};
      const s = /* @__PURE__ */ new Set();
      for (const m of i)
        if (typeof m == "string" || typeof m == "number" || typeof m == "symbol") {
          s.add(typeof m == "number" ? m.toString() : m);
          const h = t.valueType._zod.run({ value: o[m], issues: [] }, n);
          h instanceof Promise ? a.push(h.then((g) => {
            g.issues.length && r.issues.push(...Lt(m, g.issues)), r.value[m] = g.value;
          })) : (h.issues.length && r.issues.push(...Lt(m, h.issues)), r.value[m] = h.value);
        }
      let d;
      for (const m in o)
        s.has(m) || (d = d ?? [], d.push(m));
      d && d.length > 0 && r.issues.push({
        code: "unrecognized_keys",
        input: o,
        inst: e,
        keys: d
      });
    } else {
      r.value = {};
      for (const s of Reflect.ownKeys(o)) {
        if (s === "__proto__")
          continue;
        let d = t.keyType._zod.run({ value: s, issues: [] }, n);
        if (d instanceof Promise)
          throw new Error("Async schemas not supported in object keys currently");
        if (typeof s == "string" && Os.test(s) && d.issues.length) {
          const g = t.keyType._zod.run({ value: Number(s), issues: [] }, n);
          if (g instanceof Promise)
            throw new Error("Async schemas not supported in object keys currently");
          g.issues.length === 0 && (d = g);
        }
        if (d.issues.length) {
          t.mode === "loose" ? r.value[s] = o[s] : r.issues.push({
            code: "invalid_key",
            origin: "record",
            issues: d.issues.map((g) => Rt(g, n, Tt())),
            input: s,
            path: [s],
            inst: e
          });
          continue;
        }
        const h = t.valueType._zod.run({ value: o[s], issues: [] }, n);
        h instanceof Promise ? a.push(h.then((g) => {
          g.issues.length && r.issues.push(...Lt(s, g.issues)), r.value[d.value] = g.value;
        })) : (h.issues.length && r.issues.push(...Lt(s, h.issues)), r.value[d.value] = h.value);
      }
    }
    return a.length ? Promise.all(a).then(() => r) : r;
  };
}), am = /* @__PURE__ */ E("$ZodEnum", (e, t) => {
  le.init(e, t);
  const r = As(t.entries), n = new Set(r);
  e._zod.values = n, e._zod.pattern = new RegExp(`^(${r.filter((o) => gu.has(typeof o)).map((o) => typeof o == "string" ? dr(o) : o.toString()).join("|")})$`), e._zod.parse = (o, a) => {
    const i = o.value;
    return n.has(i) || o.issues.push({
      code: "invalid_value",
      values: r,
      input: i,
      inst: e
    }), o;
  };
}), im = /* @__PURE__ */ E("$ZodLiteral", (e, t) => {
  if (le.init(e, t), t.values.length === 0)
    throw new Error("Cannot create literal schema with no valid values");
  const r = new Set(t.values);
  e._zod.values = r, e._zod.pattern = new RegExp(`^(${t.values.map((n) => typeof n == "string" ? dr(n) : n ? dr(n.toString()) : String(n)).join("|")})$`), e._zod.parse = (n, o) => {
    const a = n.value;
    return r.has(a) || n.issues.push({
      code: "invalid_value",
      values: t.values,
      input: a,
      inst: e
    }), n;
  };
}), sm = /* @__PURE__ */ E("$ZodTransform", (e, t) => {
  le.init(e, t), e._zod.parse = (r, n) => {
    if (n.direction === "backward")
      throw new Es(e.constructor.name);
    const o = t.transform(r.value, r);
    if (n.async)
      return (o instanceof Promise ? o : Promise.resolve(o)).then((i) => (r.value = i, r));
    if (o instanceof Promise)
      throw new ir();
    return r.value = o, r;
  };
});
function ri(e, t) {
  return e.issues.length && t === void 0 ? { issues: [], value: void 0 } : e;
}
const Zs = /* @__PURE__ */ E("$ZodOptional", (e, t) => {
  le.init(e, t), e._zod.optin = "optional", e._zod.optout = "optional", ne(e._zod, "values", () => t.innerType._zod.values ? /* @__PURE__ */ new Set([...t.innerType._zod.values, void 0]) : void 0), ne(e._zod, "pattern", () => {
    const r = t.innerType._zod.pattern;
    return r ? new RegExp(`^(${Uo(r.source)})?$`) : void 0;
  }), e._zod.parse = (r, n) => {
    if (t.innerType._zod.optin === "optional") {
      const o = t.innerType._zod.run(r, n);
      return o instanceof Promise ? o.then((a) => ri(a, r.value)) : ri(o, r.value);
    }
    return r.value === void 0 ? r : t.innerType._zod.run(r, n);
  };
}), cm = /* @__PURE__ */ E("$ZodExactOptional", (e, t) => {
  Zs.init(e, t), ne(e._zod, "values", () => t.innerType._zod.values), ne(e._zod, "pattern", () => t.innerType._zod.pattern), e._zod.parse = (r, n) => t.innerType._zod.run(r, n);
}), dm = /* @__PURE__ */ E("$ZodNullable", (e, t) => {
  le.init(e, t), ne(e._zod, "optin", () => t.innerType._zod.optin), ne(e._zod, "optout", () => t.innerType._zod.optout), ne(e._zod, "pattern", () => {
    const r = t.innerType._zod.pattern;
    return r ? new RegExp(`^(${Uo(r.source)}|null)$`) : void 0;
  }), ne(e._zod, "values", () => t.innerType._zod.values ? /* @__PURE__ */ new Set([...t.innerType._zod.values, null]) : void 0), e._zod.parse = (r, n) => r.value === null ? r : t.innerType._zod.run(r, n);
}), lm = /* @__PURE__ */ E("$ZodDefault", (e, t) => {
  le.init(e, t), e._zod.optin = "optional", ne(e._zod, "values", () => t.innerType._zod.values), e._zod.parse = (r, n) => {
    if (n.direction === "backward")
      return t.innerType._zod.run(r, n);
    if (r.value === void 0)
      return r.value = t.defaultValue, r;
    const o = t.innerType._zod.run(r, n);
    return o instanceof Promise ? o.then((a) => ni(a, t)) : ni(o, t);
  };
});
function ni(e, t) {
  return e.value === void 0 && (e.value = t.defaultValue), e;
}
const um = /* @__PURE__ */ E("$ZodPrefault", (e, t) => {
  le.init(e, t), e._zod.optin = "optional", ne(e._zod, "values", () => t.innerType._zod.values), e._zod.parse = (r, n) => (n.direction === "backward" || r.value === void 0 && (r.value = t.defaultValue), t.innerType._zod.run(r, n));
}), pm = /* @__PURE__ */ E("$ZodNonOptional", (e, t) => {
  le.init(e, t), ne(e._zod, "values", () => {
    const r = t.innerType._zod.values;
    return r ? new Set([...r].filter((n) => n !== void 0)) : void 0;
  }), e._zod.parse = (r, n) => {
    const o = t.innerType._zod.run(r, n);
    return o instanceof Promise ? o.then((a) => oi(a, e)) : oi(o, e);
  };
});
function oi(e, t) {
  return !e.issues.length && e.value === void 0 && e.issues.push({
    code: "invalid_type",
    expected: "nonoptional",
    input: e.value,
    inst: t
  }), e;
}
const mm = /* @__PURE__ */ E("$ZodCatch", (e, t) => {
  le.init(e, t), ne(e._zod, "optin", () => t.innerType._zod.optin), ne(e._zod, "optout", () => t.innerType._zod.optout), ne(e._zod, "values", () => t.innerType._zod.values), e._zod.parse = (r, n) => {
    if (n.direction === "backward")
      return t.innerType._zod.run(r, n);
    const o = t.innerType._zod.run(r, n);
    return o instanceof Promise ? o.then((a) => (r.value = a.value, a.issues.length && (r.value = t.catchValue({
      ...r,
      error: {
        issues: a.issues.map((i) => Rt(i, n, Tt()))
      },
      input: r.value
    }), r.issues = []), r)) : (r.value = o.value, o.issues.length && (r.value = t.catchValue({
      ...r,
      error: {
        issues: o.issues.map((a) => Rt(a, n, Tt()))
      },
      input: r.value
    }), r.issues = []), r);
  };
}), fm = /* @__PURE__ */ E("$ZodPipe", (e, t) => {
  le.init(e, t), ne(e._zod, "values", () => t.in._zod.values), ne(e._zod, "optin", () => t.in._zod.optin), ne(e._zod, "optout", () => t.out._zod.optout), ne(e._zod, "propValues", () => t.in._zod.propValues), e._zod.parse = (r, n) => {
    if (n.direction === "backward") {
      const a = t.out._zod.run(r, n);
      return a instanceof Promise ? a.then((i) => nn(i, t.in, n)) : nn(a, t.in, n);
    }
    const o = t.in._zod.run(r, n);
    return o instanceof Promise ? o.then((a) => nn(a, t.out, n)) : nn(o, t.out, n);
  };
});
function nn(e, t, r) {
  return e.issues.length ? (e.aborted = !0, e) : t._zod.run({ value: e.value, issues: e.issues }, r);
}
const hm = /* @__PURE__ */ E("$ZodReadonly", (e, t) => {
  le.init(e, t), ne(e._zod, "propValues", () => t.innerType._zod.propValues), ne(e._zod, "values", () => t.innerType._zod.values), ne(e._zod, "optin", () => t.innerType?._zod?.optin), ne(e._zod, "optout", () => t.innerType?._zod?.optout), e._zod.parse = (r, n) => {
    if (n.direction === "backward")
      return t.innerType._zod.run(r, n);
    const o = t.innerType._zod.run(r, n);
    return o instanceof Promise ? o.then(ai) : ai(o);
  };
});
function ai(e) {
  return e.value = Object.freeze(e.value), e;
}
const gm = /* @__PURE__ */ E("$ZodCustom", (e, t) => {
  Fe.init(e, t), le.init(e, t), e._zod.parse = (r, n) => r, e._zod.check = (r) => {
    const n = r.value, o = t.fn(n);
    if (o instanceof Promise)
      return o.then((a) => ii(a, r, n, e));
    ii(o, r, n, e);
  };
});
function ii(e, t, r, n) {
  if (!e) {
    const o = {
      code: "custom",
      input: r,
      inst: n,
      // incorporates params.error into issue reporting
      path: [...n._zod.def.path ?? []],
      // incorporates params.error into issue reporting
      continue: !n._zod.def.abort
      // params: inst._zod.def.params,
    };
    n._zod.def.params && (o.params = n._zod.def.params), t.issues.push(Br(o));
  }
}
var si;
class ym {
  constructor() {
    this._map = /* @__PURE__ */ new WeakMap(), this._idmap = /* @__PURE__ */ new Map();
  }
  add(t, ...r) {
    const n = r[0];
    return this._map.set(t, n), n && typeof n == "object" && "id" in n && this._idmap.set(n.id, t), this;
  }
  clear() {
    return this._map = /* @__PURE__ */ new WeakMap(), this._idmap = /* @__PURE__ */ new Map(), this;
  }
  remove(t) {
    const r = this._map.get(t);
    return r && typeof r == "object" && "id" in r && this._idmap.delete(r.id), this._map.delete(t), this;
  }
  get(t) {
    const r = t._zod.parent;
    if (r) {
      const n = { ...this.get(r) ?? {} };
      delete n.id;
      const o = { ...n, ...this._map.get(t) };
      return Object.keys(o).length ? o : void 0;
    }
    return this._map.get(t);
  }
  has(t) {
    return this._map.has(t);
  }
}
function bm() {
  return new ym();
}
(si = globalThis).__zod_globalRegistry ?? (si.__zod_globalRegistry = bm());
const _r = globalThis.__zod_globalRegistry;
// @__NO_SIDE_EFFECTS__
function vm(e, t) {
  return new e({
    type: "string",
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function km(e, t) {
  return new e({
    type: "string",
    format: "email",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function ci(e, t) {
  return new e({
    type: "string",
    format: "guid",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function wm(e, t) {
  return new e({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Im(e, t) {
  return new e({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: !1,
    version: "v4",
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Sm(e, t) {
  return new e({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: !1,
    version: "v6",
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function xm(e, t) {
  return new e({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: !1,
    version: "v7",
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Em(e, t) {
  return new e({
    type: "string",
    format: "url",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Pm(e, t) {
  return new e({
    type: "string",
    format: "emoji",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Am(e, t) {
  return new e({
    type: "string",
    format: "nanoid",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function _m(e, t) {
  return new e({
    type: "string",
    format: "cuid",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function zm(e, t) {
  return new e({
    type: "string",
    format: "cuid2",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Tm(e, t) {
  return new e({
    type: "string",
    format: "ulid",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Rm(e, t) {
  return new e({
    type: "string",
    format: "xid",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Cm(e, t) {
  return new e({
    type: "string",
    format: "ksuid",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Mm(e, t) {
  return new e({
    type: "string",
    format: "ipv4",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Dm(e, t) {
  return new e({
    type: "string",
    format: "ipv6",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Vm(e, t) {
  return new e({
    type: "string",
    format: "cidrv4",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Om(e, t) {
  return new e({
    type: "string",
    format: "cidrv6",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Bm(e, t) {
  return new e({
    type: "string",
    format: "base64",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Fm(e, t) {
  return new e({
    type: "string",
    format: "base64url",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Nm(e, t) {
  return new e({
    type: "string",
    format: "e164",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function $m(e, t) {
  return new e({
    type: "string",
    format: "jwt",
    check: "string_format",
    abort: !1,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function qm(e, t) {
  return new e({
    type: "string",
    format: "datetime",
    check: "string_format",
    offset: !1,
    local: !1,
    precision: null,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Hm(e, t) {
  return new e({
    type: "string",
    format: "date",
    check: "string_format",
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Lm(e, t) {
  return new e({
    type: "string",
    format: "time",
    check: "string_format",
    precision: null,
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Um(e, t) {
  return new e({
    type: "string",
    format: "duration",
    check: "string_format",
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Zm(e, t) {
  return new e({
    type: "number",
    checks: [],
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function jm(e, t) {
  return new e({
    type: "number",
    check: "number_format",
    abort: !1,
    format: "safeint",
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Km(e, t) {
  return new e({
    type: "boolean",
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function Wm(e) {
  return new e({
    type: "unknown"
  });
}
// @__NO_SIDE_EFFECTS__
function Gm(e, t) {
  return new e({
    type: "never",
    ...F(t)
  });
}
// @__NO_SIDE_EFFECTS__
function di(e, t) {
  return new Fs({
    check: "less_than",
    ...F(t),
    value: e,
    inclusive: !1
  });
}
// @__NO_SIDE_EFFECTS__
function to(e, t) {
  return new Fs({
    check: "less_than",
    ...F(t),
    value: e,
    inclusive: !0
  });
}
// @__NO_SIDE_EFFECTS__
function li(e, t) {
  return new Ns({
    check: "greater_than",
    ...F(t),
    value: e,
    inclusive: !1
  });
}
// @__NO_SIDE_EFFECTS__
function ro(e, t) {
  return new Ns({
    check: "greater_than",
    ...F(t),
    value: e,
    inclusive: !0
  });
}
// @__NO_SIDE_EFFECTS__
function ui(e, t) {
  return new dp({
    check: "multiple_of",
    ...F(t),
    value: e
  });
}
// @__NO_SIDE_EFFECTS__
function js(e, t) {
  return new up({
    check: "max_length",
    ...F(t),
    maximum: e
  });
}
// @__NO_SIDE_EFFECTS__
function pn(e, t) {
  return new pp({
    check: "min_length",
    ...F(t),
    minimum: e
  });
}
// @__NO_SIDE_EFFECTS__
function Ks(e, t) {
  return new mp({
    check: "length_equals",
    ...F(t),
    length: e
  });
}
// @__NO_SIDE_EFFECTS__
function Qm(e, t) {
  return new fp({
    check: "string_format",
    format: "regex",
    ...F(t),
    pattern: e
  });
}
// @__NO_SIDE_EFFECTS__
function Jm(e) {
  return new hp({
    check: "string_format",
    format: "lowercase",
    ...F(e)
  });
}
// @__NO_SIDE_EFFECTS__
function Xm(e) {
  return new gp({
    check: "string_format",
    format: "uppercase",
    ...F(e)
  });
}
// @__NO_SIDE_EFFECTS__
function Ym(e, t) {
  return new yp({
    check: "string_format",
    format: "includes",
    ...F(t),
    includes: e
  });
}
// @__NO_SIDE_EFFECTS__
function ef(e, t) {
  return new bp({
    check: "string_format",
    format: "starts_with",
    ...F(t),
    prefix: e
  });
}
// @__NO_SIDE_EFFECTS__
function tf(e, t) {
  return new vp({
    check: "string_format",
    format: "ends_with",
    ...F(t),
    suffix: e
  });
}
// @__NO_SIDE_EFFECTS__
function pr(e) {
  return new kp({
    check: "overwrite",
    tx: e
  });
}
// @__NO_SIDE_EFFECTS__
function rf(e) {
  return /* @__PURE__ */ pr((t) => t.normalize(e));
}
// @__NO_SIDE_EFFECTS__
function nf() {
  return /* @__PURE__ */ pr((e) => e.trim());
}
// @__NO_SIDE_EFFECTS__
function of() {
  return /* @__PURE__ */ pr((e) => e.toLowerCase());
}
// @__NO_SIDE_EFFECTS__
function af() {
  return /* @__PURE__ */ pr((e) => e.toUpperCase());
}
// @__NO_SIDE_EFFECTS__
function sf() {
  return /* @__PURE__ */ pr((e) => fu(e));
}
// @__NO_SIDE_EFFECTS__
function cf(e, t, r) {
  return new e({
    type: "array",
    element: t,
    // get element() {
    //   return element;
    // },
    ...F(r)
  });
}
// @__NO_SIDE_EFFECTS__
function df(e, t, r) {
  const n = F(r);
  return n.abort ?? (n.abort = !0), new e({
    type: "custom",
    check: "custom",
    fn: t,
    ...n
  });
}
// @__NO_SIDE_EFFECTS__
function lf(e, t, r) {
  return new e({
    type: "custom",
    check: "custom",
    fn: t,
    ...F(r)
  });
}
// @__NO_SIDE_EFFECTS__
function uf(e) {
  const t = /* @__PURE__ */ pf((r) => (r.addIssue = (n) => {
    if (typeof n == "string")
      r.issues.push(Br(n, r.value, t._zod.def));
    else {
      const o = n;
      o.fatal && (o.continue = !1), o.code ?? (o.code = "custom"), o.input ?? (o.input = r.value), o.inst ?? (o.inst = t), o.continue ?? (o.continue = !t._zod.def.abort), r.issues.push(Br(o));
    }
  }, e(r.value, r)));
  return t;
}
// @__NO_SIDE_EFFECTS__
function pf(e, t) {
  const r = new Fe({
    check: "custom",
    ...F(t)
  });
  return r._zod.check = e, r;
}
function Ws(e) {
  let t = e?.target ?? "draft-2020-12";
  return t === "draft-4" && (t = "draft-04"), t === "draft-7" && (t = "draft-07"), {
    processors: e.processors ?? {},
    metadataRegistry: e?.metadata ?? _r,
    target: t,
    unrepresentable: e?.unrepresentable ?? "throw",
    override: e?.override ?? (() => {
    }),
    io: e?.io ?? "output",
    counter: 0,
    seen: /* @__PURE__ */ new Map(),
    cycles: e?.cycles ?? "ref",
    reused: e?.reused ?? "inline",
    external: e?.external ?? void 0
  };
}
function we(e, t, r = { path: [], schemaPath: [] }) {
  var n;
  const o = e._zod.def, a = t.seen.get(e);
  if (a)
    return a.count++, r.schemaPath.includes(e) && (a.cycle = r.path), a.schema;
  const i = { schema: {}, count: 1, cycle: void 0, path: r.path };
  t.seen.set(e, i);
  const s = e._zod.toJSONSchema?.();
  if (s)
    i.schema = s;
  else {
    const h = {
      ...r,
      schemaPath: [...r.schemaPath, e],
      path: r.path
    };
    if (e._zod.processJSONSchema)
      e._zod.processJSONSchema(t, i.schema, h);
    else {
      const S = i.schema, _ = t.processors[o.type];
      if (!_)
        throw new Error(`[toJSONSchema]: Non-representable type encountered: ${o.type}`);
      _(e, t, S, h);
    }
    const g = e._zod.parent;
    g && (i.ref || (i.ref = g), we(g, t, h), t.seen.get(g).isParent = !0);
  }
  const d = t.metadataRegistry.get(e);
  return d && Object.assign(i.schema, d), t.io === "input" && Me(e) && (delete i.schema.examples, delete i.schema.default), t.io === "input" && i.schema._prefault && ((n = i.schema).default ?? (n.default = i.schema._prefault)), delete i.schema._prefault, t.seen.get(e).schema;
}
function Gs(e, t) {
  const r = e.seen.get(t);
  if (!r)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  const n = /* @__PURE__ */ new Map();
  for (const i of e.seen.entries()) {
    const s = e.metadataRegistry.get(i[0])?.id;
    if (s) {
      const d = n.get(s);
      if (d && d !== i[0])
        throw new Error(`Duplicate schema id "${s}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
      n.set(s, i[0]);
    }
  }
  const o = (i) => {
    const s = e.target === "draft-2020-12" ? "$defs" : "definitions";
    if (e.external) {
      const g = e.external.registry.get(i[0])?.id, S = e.external.uri ?? ((H) => H);
      if (g)
        return { ref: S(g) };
      const _ = i[1].defId ?? i[1].schema.id ?? `schema${e.counter++}`;
      return i[1].defId = _, { defId: _, ref: `${S("__shared")}#/${s}/${_}` };
    }
    if (i[1] === r)
      return { ref: "#" };
    const m = `#/${s}/`, h = i[1].schema.id ?? `__schema${e.counter++}`;
    return { defId: h, ref: m + h };
  }, a = (i) => {
    if (i[1].schema.$ref)
      return;
    const s = i[1], { ref: d, defId: m } = o(i);
    s.def = { ...s.schema }, m && (s.defId = m);
    const h = s.schema;
    for (const g in h)
      delete h[g];
    h.$ref = d;
  };
  if (e.cycles === "throw")
    for (const i of e.seen.entries()) {
      const s = i[1];
      if (s.cycle)
        throw new Error(`Cycle detected: #/${s.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
    }
  for (const i of e.seen.entries()) {
    const s = i[1];
    if (t === i[0]) {
      a(i);
      continue;
    }
    if (e.external) {
      const m = e.external.registry.get(i[0])?.id;
      if (t !== i[0] && m) {
        a(i);
        continue;
      }
    }
    if (e.metadataRegistry.get(i[0])?.id) {
      a(i);
      continue;
    }
    if (s.cycle) {
      a(i);
      continue;
    }
    if (s.count > 1 && e.reused === "ref") {
      a(i);
      continue;
    }
  }
}
function Qs(e, t) {
  const r = e.seen.get(t);
  if (!r)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  const n = (i) => {
    const s = e.seen.get(i);
    if (s.ref === null)
      return;
    const d = s.def ?? s.schema, m = { ...d }, h = s.ref;
    if (s.ref = null, h) {
      n(h);
      const S = e.seen.get(h), _ = S.schema;
      if (_.$ref && (e.target === "draft-07" || e.target === "draft-04" || e.target === "openapi-3.0") ? (d.allOf = d.allOf ?? [], d.allOf.push(_)) : Object.assign(d, _), Object.assign(d, m), i._zod.parent === h)
        for (const q in d)
          q === "$ref" || q === "allOf" || q in m || delete d[q];
      if (_.$ref && S.def)
        for (const q in d)
          q === "$ref" || q === "allOf" || q in S.def && JSON.stringify(d[q]) === JSON.stringify(S.def[q]) && delete d[q];
    }
    const g = i._zod.parent;
    if (g && g !== h) {
      n(g);
      const S = e.seen.get(g);
      if (S?.schema.$ref && (d.$ref = S.schema.$ref, S.def))
        for (const _ in d)
          _ === "$ref" || _ === "allOf" || _ in S.def && JSON.stringify(d[_]) === JSON.stringify(S.def[_]) && delete d[_];
    }
    e.override({
      zodSchema: i,
      jsonSchema: d,
      path: s.path ?? []
    });
  };
  for (const i of [...e.seen.entries()].reverse())
    n(i[0]);
  const o = {};
  if (e.target === "draft-2020-12" ? o.$schema = "https://json-schema.org/draft/2020-12/schema" : e.target === "draft-07" ? o.$schema = "http://json-schema.org/draft-07/schema#" : e.target === "draft-04" ? o.$schema = "http://json-schema.org/draft-04/schema#" : e.target, e.external?.uri) {
    const i = e.external.registry.get(t)?.id;
    if (!i)
      throw new Error("Schema is missing an `id` property");
    o.$id = e.external.uri(i);
  }
  Object.assign(o, r.def ?? r.schema);
  const a = e.external?.defs ?? {};
  for (const i of e.seen.entries()) {
    const s = i[1];
    s.def && s.defId && (a[s.defId] = s.def);
  }
  e.external || Object.keys(a).length > 0 && (e.target === "draft-2020-12" ? o.$defs = a : o.definitions = a);
  try {
    const i = JSON.parse(JSON.stringify(o));
    return Object.defineProperty(i, "~standard", {
      value: {
        ...t["~standard"],
        jsonSchema: {
          input: mn(t, "input", e.processors),
          output: mn(t, "output", e.processors)
        }
      },
      enumerable: !1,
      writable: !1
    }), i;
  } catch {
    throw new Error("Error converting schema to JSON.");
  }
}
function Me(e, t) {
  const r = t ?? { seen: /* @__PURE__ */ new Set() };
  if (r.seen.has(e))
    return !1;
  r.seen.add(e);
  const n = e._zod.def;
  if (n.type === "transform")
    return !0;
  if (n.type === "array")
    return Me(n.element, r);
  if (n.type === "set")
    return Me(n.valueType, r);
  if (n.type === "lazy")
    return Me(n.getter(), r);
  if (n.type === "promise" || n.type === "optional" || n.type === "nonoptional" || n.type === "nullable" || n.type === "readonly" || n.type === "default" || n.type === "prefault")
    return Me(n.innerType, r);
  if (n.type === "intersection")
    return Me(n.left, r) || Me(n.right, r);
  if (n.type === "record" || n.type === "map")
    return Me(n.keyType, r) || Me(n.valueType, r);
  if (n.type === "pipe")
    return Me(n.in, r) || Me(n.out, r);
  if (n.type === "object") {
    for (const o in n.shape)
      if (Me(n.shape[o], r))
        return !0;
    return !1;
  }
  if (n.type === "union") {
    for (const o of n.options)
      if (Me(o, r))
        return !0;
    return !1;
  }
  if (n.type === "tuple") {
    for (const o of n.items)
      if (Me(o, r))
        return !0;
    return !!(n.rest && Me(n.rest, r));
  }
  return !1;
}
const mf = (e, t = {}) => (r) => {
  const n = Ws({ ...r, processors: t });
  return we(e, n), Gs(n, e), Qs(n, e);
}, mn = (e, t, r = {}) => (n) => {
  const { libraryOptions: o, target: a } = n ?? {}, i = Ws({ ...o ?? {}, target: a, io: t, processors: r });
  return we(e, i), Gs(i, e), Qs(i, e);
}, ff = {
  guid: "uuid",
  url: "uri",
  datetime: "date-time",
  json_string: "json-string",
  regex: ""
  // do not set
}, hf = (e, t, r, n) => {
  const o = r;
  o.type = "string";
  const { minimum: a, maximum: i, format: s, patterns: d, contentEncoding: m } = e._zod.bag;
  if (typeof a == "number" && (o.minLength = a), typeof i == "number" && (o.maxLength = i), s && (o.format = ff[s] ?? s, o.format === "" && delete o.format, s === "time" && delete o.format), m && (o.contentEncoding = m), d && d.size > 0) {
    const h = [...d];
    h.length === 1 ? o.pattern = h[0].source : h.length > 1 && (o.allOf = [
      ...h.map((g) => ({
        ...t.target === "draft-07" || t.target === "draft-04" || t.target === "openapi-3.0" ? { type: "string" } : {},
        pattern: g.source
      }))
    ]);
  }
}, gf = (e, t, r, n) => {
  const o = r, { minimum: a, maximum: i, format: s, multipleOf: d, exclusiveMaximum: m, exclusiveMinimum: h } = e._zod.bag;
  typeof s == "string" && s.includes("int") ? o.type = "integer" : o.type = "number", typeof h == "number" && (t.target === "draft-04" || t.target === "openapi-3.0" ? (o.minimum = h, o.exclusiveMinimum = !0) : o.exclusiveMinimum = h), typeof a == "number" && (o.minimum = a, typeof h == "number" && t.target !== "draft-04" && (h >= a ? delete o.minimum : delete o.exclusiveMinimum)), typeof m == "number" && (t.target === "draft-04" || t.target === "openapi-3.0" ? (o.maximum = m, o.exclusiveMaximum = !0) : o.exclusiveMaximum = m), typeof i == "number" && (o.maximum = i, typeof m == "number" && t.target !== "draft-04" && (m <= i ? delete o.maximum : delete o.exclusiveMaximum)), typeof d == "number" && (o.multipleOf = d);
}, yf = (e, t, r, n) => {
  r.type = "boolean";
}, bf = (e, t, r, n) => {
  r.not = {};
}, vf = (e, t, r, n) => {
}, kf = (e, t, r, n) => {
  const o = e._zod.def, a = As(o.entries);
  a.every((i) => typeof i == "number") && (r.type = "number"), a.every((i) => typeof i == "string") && (r.type = "string"), r.enum = a;
}, wf = (e, t, r, n) => {
  const o = e._zod.def, a = [];
  for (const i of o.values)
    if (i === void 0) {
      if (t.unrepresentable === "throw")
        throw new Error("Literal `undefined` cannot be represented in JSON Schema");
    } else if (typeof i == "bigint") {
      if (t.unrepresentable === "throw")
        throw new Error("BigInt literals cannot be represented in JSON Schema");
      a.push(Number(i));
    } else
      a.push(i);
  if (a.length !== 0) if (a.length === 1) {
    const i = a[0];
    r.type = i === null ? "null" : typeof i, t.target === "draft-04" || t.target === "openapi-3.0" ? r.enum = [i] : r.const = i;
  } else
    a.every((i) => typeof i == "number") && (r.type = "number"), a.every((i) => typeof i == "string") && (r.type = "string"), a.every((i) => typeof i == "boolean") && (r.type = "boolean"), a.every((i) => i === null) && (r.type = "null"), r.enum = a;
}, If = (e, t, r, n) => {
  if (t.unrepresentable === "throw")
    throw new Error("Custom types cannot be represented in JSON Schema");
}, Sf = (e, t, r, n) => {
  if (t.unrepresentable === "throw")
    throw new Error("Transforms cannot be represented in JSON Schema");
}, xf = (e, t, r, n) => {
  const o = r, a = e._zod.def, { minimum: i, maximum: s } = e._zod.bag;
  typeof i == "number" && (o.minItems = i), typeof s == "number" && (o.maxItems = s), o.type = "array", o.items = we(a.element, t, { ...n, path: [...n.path, "items"] });
}, Ef = (e, t, r, n) => {
  const o = r, a = e._zod.def;
  o.type = "object", o.properties = {};
  const i = a.shape;
  for (const m in i)
    o.properties[m] = we(i[m], t, {
      ...n,
      path: [...n.path, "properties", m]
    });
  const s = new Set(Object.keys(i)), d = new Set([...s].filter((m) => {
    const h = a.shape[m]._zod;
    return t.io === "input" ? h.optin === void 0 : h.optout === void 0;
  }));
  d.size > 0 && (o.required = Array.from(d)), a.catchall?._zod.def.type === "never" ? o.additionalProperties = !1 : a.catchall ? a.catchall && (o.additionalProperties = we(a.catchall, t, {
    ...n,
    path: [...n.path, "additionalProperties"]
  })) : t.io === "output" && (o.additionalProperties = !1);
}, Pf = (e, t, r, n) => {
  const o = e._zod.def, a = o.inclusive === !1, i = o.options.map((s, d) => we(s, t, {
    ...n,
    path: [...n.path, a ? "oneOf" : "anyOf", d]
  }));
  a ? r.oneOf = i : r.anyOf = i;
}, Af = (e, t, r, n) => {
  const o = e._zod.def, a = we(o.left, t, {
    ...n,
    path: [...n.path, "allOf", 0]
  }), i = we(o.right, t, {
    ...n,
    path: [...n.path, "allOf", 1]
  }), s = (m) => "allOf" in m && Object.keys(m).length === 1, d = [
    ...s(a) ? a.allOf : [a],
    ...s(i) ? i.allOf : [i]
  ];
  r.allOf = d;
}, _f = (e, t, r, n) => {
  const o = r, a = e._zod.def;
  o.type = "array";
  const i = t.target === "draft-2020-12" ? "prefixItems" : "items", s = t.target === "draft-2020-12" || t.target === "openapi-3.0" ? "items" : "additionalItems", d = a.items.map((S, _) => we(S, t, {
    ...n,
    path: [...n.path, i, _]
  })), m = a.rest ? we(a.rest, t, {
    ...n,
    path: [...n.path, s, ...t.target === "openapi-3.0" ? [a.items.length] : []]
  }) : null;
  t.target === "draft-2020-12" ? (o.prefixItems = d, m && (o.items = m)) : t.target === "openapi-3.0" ? (o.items = {
    anyOf: d
  }, m && o.items.anyOf.push(m), o.minItems = d.length, m || (o.maxItems = d.length)) : (o.items = d, m && (o.additionalItems = m));
  const { minimum: h, maximum: g } = e._zod.bag;
  typeof h == "number" && (o.minItems = h), typeof g == "number" && (o.maxItems = g);
}, zf = (e, t, r, n) => {
  const o = r, a = e._zod.def;
  o.type = "object";
  const i = a.keyType, d = i._zod.bag?.patterns;
  if (a.mode === "loose" && d && d.size > 0) {
    const h = we(a.valueType, t, {
      ...n,
      path: [...n.path, "patternProperties", "*"]
    });
    o.patternProperties = {};
    for (const g of d)
      o.patternProperties[g.source] = h;
  } else
    (t.target === "draft-07" || t.target === "draft-2020-12") && (o.propertyNames = we(a.keyType, t, {
      ...n,
      path: [...n.path, "propertyNames"]
    })), o.additionalProperties = we(a.valueType, t, {
      ...n,
      path: [...n.path, "additionalProperties"]
    });
  const m = i._zod.values;
  if (m) {
    const h = [...m].filter((g) => typeof g == "string" || typeof g == "number");
    h.length > 0 && (o.required = h);
  }
}, Tf = (e, t, r, n) => {
  const o = e._zod.def, a = we(o.innerType, t, n), i = t.seen.get(e);
  t.target === "openapi-3.0" ? (i.ref = o.innerType, r.nullable = !0) : r.anyOf = [a, { type: "null" }];
}, Rf = (e, t, r, n) => {
  const o = e._zod.def;
  we(o.innerType, t, n);
  const a = t.seen.get(e);
  a.ref = o.innerType;
}, Cf = (e, t, r, n) => {
  const o = e._zod.def;
  we(o.innerType, t, n);
  const a = t.seen.get(e);
  a.ref = o.innerType, r.default = JSON.parse(JSON.stringify(o.defaultValue));
}, Mf = (e, t, r, n) => {
  const o = e._zod.def;
  we(o.innerType, t, n);
  const a = t.seen.get(e);
  a.ref = o.innerType, t.io === "input" && (r._prefault = JSON.parse(JSON.stringify(o.defaultValue)));
}, Df = (e, t, r, n) => {
  const o = e._zod.def;
  we(o.innerType, t, n);
  const a = t.seen.get(e);
  a.ref = o.innerType;
  let i;
  try {
    i = o.catchValue(void 0);
  } catch {
    throw new Error("Dynamic catch values are not supported in JSON Schema");
  }
  r.default = i;
}, Vf = (e, t, r, n) => {
  const o = e._zod.def, a = t.io === "input" ? o.in._zod.def.type === "transform" ? o.out : o.in : o.out;
  we(a, t, n);
  const i = t.seen.get(e);
  i.ref = a;
}, Of = (e, t, r, n) => {
  const o = e._zod.def;
  we(o.innerType, t, n);
  const a = t.seen.get(e);
  a.ref = o.innerType, r.readOnly = !0;
}, Js = (e, t, r, n) => {
  const o = e._zod.def;
  we(o.innerType, t, n);
  const a = t.seen.get(e);
  a.ref = o.innerType;
}, Bf = /* @__PURE__ */ E("ZodISODateTime", (e, t) => {
  Dp.init(e, t), be.init(e, t);
});
function Ff(e) {
  return /* @__PURE__ */ qm(Bf, e);
}
const Nf = /* @__PURE__ */ E("ZodISODate", (e, t) => {
  Vp.init(e, t), be.init(e, t);
});
function $f(e) {
  return /* @__PURE__ */ Hm(Nf, e);
}
const qf = /* @__PURE__ */ E("ZodISOTime", (e, t) => {
  Op.init(e, t), be.init(e, t);
});
function Hf(e) {
  return /* @__PURE__ */ Lm(qf, e);
}
const Lf = /* @__PURE__ */ E("ZodISODuration", (e, t) => {
  Bp.init(e, t), be.init(e, t);
});
function Uf(e) {
  return /* @__PURE__ */ Um(Lf, e);
}
const Zf = (e, t) => {
  Rs.init(e, t), e.name = "ZodError", Object.defineProperties(e, {
    format: {
      value: (r) => Au(e, r)
      // enumerable: false,
    },
    flatten: {
      value: (r) => Pu(e, r)
      // enumerable: false,
    },
    addIssue: {
      value: (r) => {
        e.issues.push(r), e.message = JSON.stringify(e.issues, vo, 2);
      }
      // enumerable: false,
    },
    addIssues: {
      value: (r) => {
        e.issues.push(...r), e.message = JSON.stringify(e.issues, vo, 2);
      }
      // enumerable: false,
    },
    isEmpty: {
      get() {
        return e.issues.length === 0;
      }
      // enumerable: false,
    }
  });
}, We = E("ZodError", Zf, {
  Parent: Error
}), jf = /* @__PURE__ */ jo(We), Kf = /* @__PURE__ */ Ko(We), Wf = /* @__PURE__ */ Cn(We), Gf = /* @__PURE__ */ Mn(We), Qf = /* @__PURE__ */ Tu(We), Jf = /* @__PURE__ */ Ru(We), Xf = /* @__PURE__ */ Cu(We), Yf = /* @__PURE__ */ Mu(We), eh = /* @__PURE__ */ Du(We), th = /* @__PURE__ */ Vu(We), rh = /* @__PURE__ */ Ou(We), nh = /* @__PURE__ */ Bu(We), ge = /* @__PURE__ */ E("ZodType", (e, t) => (le.init(e, t), Object.assign(e["~standard"], {
  jsonSchema: {
    input: mn(e, "input"),
    output: mn(e, "output")
  }
}), e.toJSONSchema = mf(e, {}), e.def = t, e.type = t.type, Object.defineProperty(e, "_def", { value: t }), e.check = (...r) => e.clone(Vt(t, {
  checks: [
    ...t.checks ?? [],
    ...r.map((n) => typeof n == "function" ? { _zod: { check: n, def: { check: "custom" }, onattach: [] } } : n)
  ]
}), {
  parent: !0
}), e.with = e.check, e.clone = (r, n) => Ot(e, r, n), e.brand = () => e, e.register = ((r, n) => (r.add(e, n), e)), e.parse = (r, n) => jf(e, r, n, { callee: e.parse }), e.safeParse = (r, n) => Wf(e, r, n), e.parseAsync = async (r, n) => Kf(e, r, n, { callee: e.parseAsync }), e.safeParseAsync = async (r, n) => Gf(e, r, n), e.spa = e.safeParseAsync, e.encode = (r, n) => Qf(e, r, n), e.decode = (r, n) => Jf(e, r, n), e.encodeAsync = async (r, n) => Xf(e, r, n), e.decodeAsync = async (r, n) => Yf(e, r, n), e.safeEncode = (r, n) => eh(e, r, n), e.safeDecode = (r, n) => th(e, r, n), e.safeEncodeAsync = async (r, n) => rh(e, r, n), e.safeDecodeAsync = async (r, n) => nh(e, r, n), e.refine = (r, n) => e.check(Qh(r, n)), e.superRefine = (r) => e.check(Jh(r)), e.overwrite = (r) => e.check(/* @__PURE__ */ pr(r)), e.optional = () => fi(e), e.exactOptional = () => Bh(e), e.nullable = () => hi(e), e.nullish = () => fi(hi(e)), e.nonoptional = (r) => Lh(e, r), e.array = () => T(e), e.or = (r) => ce([e, r]), e.and = (r) => Rh(e, r), e.transform = (r) => Io(e, nc(r)), e.default = (r) => $h(e, r), e.prefault = (r) => Hh(e, r), e.catch = (r) => Zh(e, r), e.pipe = (r) => Io(e, r), e.readonly = () => Wh(e), e.describe = (r) => {
  const n = e.clone();
  return _r.add(n, { description: r }), n;
}, Object.defineProperty(e, "description", {
  get() {
    return _r.get(e)?.description;
  },
  configurable: !0
}), e.meta = (...r) => {
  if (r.length === 0)
    return _r.get(e);
  const n = e.clone();
  return _r.add(n, r[0]), n;
}, e.isOptional = () => e.safeParse(void 0).success, e.isNullable = () => e.safeParse(null).success, e.apply = (r) => r(e), e)), Xs = /* @__PURE__ */ E("_ZodString", (e, t) => {
  Wo.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (n, o, a) => hf(e, n, o);
  const r = e._zod.bag;
  e.format = r.format ?? null, e.minLength = r.minimum ?? null, e.maxLength = r.maximum ?? null, e.regex = (...n) => e.check(/* @__PURE__ */ Qm(...n)), e.includes = (...n) => e.check(/* @__PURE__ */ Ym(...n)), e.startsWith = (...n) => e.check(/* @__PURE__ */ ef(...n)), e.endsWith = (...n) => e.check(/* @__PURE__ */ tf(...n)), e.min = (...n) => e.check(/* @__PURE__ */ pn(...n)), e.max = (...n) => e.check(/* @__PURE__ */ js(...n)), e.length = (...n) => e.check(/* @__PURE__ */ Ks(...n)), e.nonempty = (...n) => e.check(/* @__PURE__ */ pn(1, ...n)), e.lowercase = (n) => e.check(/* @__PURE__ */ Jm(n)), e.uppercase = (n) => e.check(/* @__PURE__ */ Xm(n)), e.trim = () => e.check(/* @__PURE__ */ nf()), e.normalize = (...n) => e.check(/* @__PURE__ */ rf(...n)), e.toLowerCase = () => e.check(/* @__PURE__ */ of()), e.toUpperCase = () => e.check(/* @__PURE__ */ af()), e.slugify = () => e.check(/* @__PURE__ */ sf());
}), oh = /* @__PURE__ */ E("ZodString", (e, t) => {
  Wo.init(e, t), Xs.init(e, t), e.email = (r) => e.check(/* @__PURE__ */ km(ah, r)), e.url = (r) => e.check(/* @__PURE__ */ Em(ih, r)), e.jwt = (r) => e.check(/* @__PURE__ */ $m(wh, r)), e.emoji = (r) => e.check(/* @__PURE__ */ Pm(sh, r)), e.guid = (r) => e.check(/* @__PURE__ */ ci(pi, r)), e.uuid = (r) => e.check(/* @__PURE__ */ wm(on, r)), e.uuidv4 = (r) => e.check(/* @__PURE__ */ Im(on, r)), e.uuidv6 = (r) => e.check(/* @__PURE__ */ Sm(on, r)), e.uuidv7 = (r) => e.check(/* @__PURE__ */ xm(on, r)), e.nanoid = (r) => e.check(/* @__PURE__ */ Am(ch, r)), e.guid = (r) => e.check(/* @__PURE__ */ ci(pi, r)), e.cuid = (r) => e.check(/* @__PURE__ */ _m(dh, r)), e.cuid2 = (r) => e.check(/* @__PURE__ */ zm(lh, r)), e.ulid = (r) => e.check(/* @__PURE__ */ Tm(uh, r)), e.base64 = (r) => e.check(/* @__PURE__ */ Bm(bh, r)), e.base64url = (r) => e.check(/* @__PURE__ */ Fm(vh, r)), e.xid = (r) => e.check(/* @__PURE__ */ Rm(ph, r)), e.ksuid = (r) => e.check(/* @__PURE__ */ Cm(mh, r)), e.ipv4 = (r) => e.check(/* @__PURE__ */ Mm(fh, r)), e.ipv6 = (r) => e.check(/* @__PURE__ */ Dm(hh, r)), e.cidrv4 = (r) => e.check(/* @__PURE__ */ Vm(gh, r)), e.cidrv6 = (r) => e.check(/* @__PURE__ */ Om(yh, r)), e.e164 = (r) => e.check(/* @__PURE__ */ Nm(kh, r)), e.datetime = (r) => e.check(Ff(r)), e.date = (r) => e.check($f(r)), e.time = (r) => e.check(Hf(r)), e.duration = (r) => e.check(Uf(r));
});
function R(e) {
  return /* @__PURE__ */ vm(oh, e);
}
const be = /* @__PURE__ */ E("ZodStringFormat", (e, t) => {
  he.init(e, t), Xs.init(e, t);
}), ah = /* @__PURE__ */ E("ZodEmail", (e, t) => {
  Ep.init(e, t), be.init(e, t);
}), pi = /* @__PURE__ */ E("ZodGUID", (e, t) => {
  Sp.init(e, t), be.init(e, t);
}), on = /* @__PURE__ */ E("ZodUUID", (e, t) => {
  xp.init(e, t), be.init(e, t);
}), ih = /* @__PURE__ */ E("ZodURL", (e, t) => {
  Pp.init(e, t), be.init(e, t);
}), sh = /* @__PURE__ */ E("ZodEmoji", (e, t) => {
  Ap.init(e, t), be.init(e, t);
}), ch = /* @__PURE__ */ E("ZodNanoID", (e, t) => {
  _p.init(e, t), be.init(e, t);
}), dh = /* @__PURE__ */ E("ZodCUID", (e, t) => {
  zp.init(e, t), be.init(e, t);
}), lh = /* @__PURE__ */ E("ZodCUID2", (e, t) => {
  Tp.init(e, t), be.init(e, t);
}), uh = /* @__PURE__ */ E("ZodULID", (e, t) => {
  Rp.init(e, t), be.init(e, t);
}), ph = /* @__PURE__ */ E("ZodXID", (e, t) => {
  Cp.init(e, t), be.init(e, t);
}), mh = /* @__PURE__ */ E("ZodKSUID", (e, t) => {
  Mp.init(e, t), be.init(e, t);
}), fh = /* @__PURE__ */ E("ZodIPv4", (e, t) => {
  Fp.init(e, t), be.init(e, t);
}), hh = /* @__PURE__ */ E("ZodIPv6", (e, t) => {
  Np.init(e, t), be.init(e, t);
}), gh = /* @__PURE__ */ E("ZodCIDRv4", (e, t) => {
  $p.init(e, t), be.init(e, t);
}), yh = /* @__PURE__ */ E("ZodCIDRv6", (e, t) => {
  qp.init(e, t), be.init(e, t);
}), bh = /* @__PURE__ */ E("ZodBase64", (e, t) => {
  Hp.init(e, t), be.init(e, t);
}), vh = /* @__PURE__ */ E("ZodBase64URL", (e, t) => {
  Up.init(e, t), be.init(e, t);
}), kh = /* @__PURE__ */ E("ZodE164", (e, t) => {
  Zp.init(e, t), be.init(e, t);
}), wh = /* @__PURE__ */ E("ZodJWT", (e, t) => {
  Kp.init(e, t), be.init(e, t);
}), Ys = /* @__PURE__ */ E("ZodNumber", (e, t) => {
  qs.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (n, o, a) => gf(e, n, o), e.gt = (n, o) => e.check(/* @__PURE__ */ li(n, o)), e.gte = (n, o) => e.check(/* @__PURE__ */ ro(n, o)), e.min = (n, o) => e.check(/* @__PURE__ */ ro(n, o)), e.lt = (n, o) => e.check(/* @__PURE__ */ di(n, o)), e.lte = (n, o) => e.check(/* @__PURE__ */ to(n, o)), e.max = (n, o) => e.check(/* @__PURE__ */ to(n, o)), e.int = (n) => e.check(mi(n)), e.safe = (n) => e.check(mi(n)), e.positive = (n) => e.check(/* @__PURE__ */ li(0, n)), e.nonnegative = (n) => e.check(/* @__PURE__ */ ro(0, n)), e.negative = (n) => e.check(/* @__PURE__ */ di(0, n)), e.nonpositive = (n) => e.check(/* @__PURE__ */ to(0, n)), e.multipleOf = (n, o) => e.check(/* @__PURE__ */ ui(n, o)), e.step = (n, o) => e.check(/* @__PURE__ */ ui(n, o)), e.finite = () => e;
  const r = e._zod.bag;
  e.minValue = Math.max(r.minimum ?? Number.NEGATIVE_INFINITY, r.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null, e.maxValue = Math.min(r.maximum ?? Number.POSITIVE_INFINITY, r.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null, e.isInt = (r.format ?? "").includes("int") || Number.isSafeInteger(r.multipleOf ?? 0.5), e.isFinite = !0, e.format = r.format ?? null;
});
function k(e) {
  return /* @__PURE__ */ Zm(Ys, e);
}
const Ih = /* @__PURE__ */ E("ZodNumberFormat", (e, t) => {
  Wp.init(e, t), Ys.init(e, t);
});
function mi(e) {
  return /* @__PURE__ */ jm(Ih, e);
}
const Sh = /* @__PURE__ */ E("ZodBoolean", (e, t) => {
  Gp.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => yf(e, r, n);
});
function M(e) {
  return /* @__PURE__ */ Km(Sh, e);
}
const xh = /* @__PURE__ */ E("ZodUnknown", (e, t) => {
  Qp.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => vf();
});
function ut() {
  return /* @__PURE__ */ Wm(xh);
}
const Eh = /* @__PURE__ */ E("ZodNever", (e, t) => {
  Jp.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => bf(e, r, n);
});
function Ph(e) {
  return /* @__PURE__ */ Gm(Eh, e);
}
const Ah = /* @__PURE__ */ E("ZodArray", (e, t) => {
  Xp.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => xf(e, r, n, o), e.element = t.element, e.min = (r, n) => e.check(/* @__PURE__ */ pn(r, n)), e.nonempty = (r) => e.check(/* @__PURE__ */ pn(1, r)), e.max = (r, n) => e.check(/* @__PURE__ */ js(r, n)), e.length = (r, n) => e.check(/* @__PURE__ */ Ks(r, n)), e.unwrap = () => e.element;
});
function T(e, t) {
  return /* @__PURE__ */ cf(Ah, e, t);
}
const _h = /* @__PURE__ */ E("ZodObject", (e, t) => {
  em.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => Ef(e, r, n, o), ne(e, "shape", () => t.shape), e.keyof = () => P(Object.keys(e._zod.def.shape)), e.catchall = (r) => e.clone({ ...e._zod.def, catchall: r }), e.passthrough = () => e.clone({ ...e._zod.def, catchall: ut() }), e.loose = () => e.clone({ ...e._zod.def, catchall: ut() }), e.strict = () => e.clone({ ...e._zod.def, catchall: Ph() }), e.strip = () => e.clone({ ...e._zod.def, catchall: void 0 }), e.extend = (r) => wu(e, r), e.safeExtend = (r) => Iu(e, r), e.merge = (r) => Su(e, r), e.pick = (r) => vu(e, r), e.omit = (r) => ku(e, r), e.partial = (...r) => xu(oc, e, r[0]), e.required = (...r) => Eu(ac, e, r[0]);
});
function c(e, t) {
  const r = {
    type: "object",
    shape: e ?? {},
    ...F(t)
  };
  return new _h(r);
}
const ec = /* @__PURE__ */ E("ZodUnion", (e, t) => {
  Us.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => Pf(e, r, n, o), e.options = t.options;
});
function ce(e, t) {
  return new ec({
    type: "union",
    options: e,
    ...F(t)
  });
}
const zh = /* @__PURE__ */ E("ZodDiscriminatedUnion", (e, t) => {
  ec.init(e, t), tm.init(e, t);
});
function J(e, t, r) {
  return new zh({
    type: "union",
    options: t,
    discriminator: e,
    ...F(r)
  });
}
const Th = /* @__PURE__ */ E("ZodIntersection", (e, t) => {
  rm.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => Af(e, r, n, o);
});
function Rh(e, t) {
  return new Th({
    type: "intersection",
    left: e,
    right: t
  });
}
const Ch = /* @__PURE__ */ E("ZodTuple", (e, t) => {
  nm.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => _f(e, r, n, o), e.rest = (r) => e.clone({
    ...e._zod.def,
    rest: r
  });
});
function tc(e, t, r) {
  const n = t instanceof le, o = n ? r : t, a = n ? t : null;
  return new Ch({
    type: "tuple",
    items: e,
    rest: a,
    ...F(o)
  });
}
const Mh = /* @__PURE__ */ E("ZodRecord", (e, t) => {
  om.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => zf(e, r, n, o), e.keyType = t.keyType, e.valueType = t.valueType;
});
function rc(e, t, r) {
  return new Mh({
    type: "record",
    keyType: e,
    valueType: t,
    ...F(r)
  });
}
const wo = /* @__PURE__ */ E("ZodEnum", (e, t) => {
  am.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (n, o, a) => kf(e, n, o), e.enum = t.entries, e.options = Object.values(t.entries);
  const r = new Set(Object.keys(t.entries));
  e.extract = (n, o) => {
    const a = {};
    for (const i of n)
      if (r.has(i))
        a[i] = t.entries[i];
      else
        throw new Error(`Key ${i} not found in enum`);
    return new wo({
      ...t,
      checks: [],
      ...F(o),
      entries: a
    });
  }, e.exclude = (n, o) => {
    const a = { ...t.entries };
    for (const i of n)
      if (r.has(i))
        delete a[i];
      else
        throw new Error(`Key ${i} not found in enum`);
    return new wo({
      ...t,
      checks: [],
      ...F(o),
      entries: a
    });
  };
});
function P(e, t) {
  const r = Array.isArray(e) ? Object.fromEntries(e.map((n) => [n, n])) : e;
  return new wo({
    type: "enum",
    entries: r,
    ...F(t)
  });
}
const Dh = /* @__PURE__ */ E("ZodLiteral", (e, t) => {
  im.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => wf(e, r, n), e.values = new Set(t.values), Object.defineProperty(e, "value", {
    get() {
      if (t.values.length > 1)
        throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
      return t.values[0];
    }
  });
});
function l(e, t) {
  return new Dh({
    type: "literal",
    values: Array.isArray(e) ? e : [e],
    ...F(t)
  });
}
const Vh = /* @__PURE__ */ E("ZodTransform", (e, t) => {
  sm.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => Sf(e, r), e._zod.parse = (r, n) => {
    if (n.direction === "backward")
      throw new Es(e.constructor.name);
    r.addIssue = (a) => {
      if (typeof a == "string")
        r.issues.push(Br(a, r.value, t));
      else {
        const i = a;
        i.fatal && (i.continue = !1), i.code ?? (i.code = "custom"), i.input ?? (i.input = r.value), i.inst ?? (i.inst = e), r.issues.push(Br(i));
      }
    };
    const o = t.transform(r.value, r);
    return o instanceof Promise ? o.then((a) => (r.value = a, r)) : (r.value = o, r);
  };
});
function nc(e) {
  return new Vh({
    type: "transform",
    transform: e
  });
}
const oc = /* @__PURE__ */ E("ZodOptional", (e, t) => {
  Zs.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => Js(e, r, n, o), e.unwrap = () => e._zod.def.innerType;
});
function fi(e) {
  return new oc({
    type: "optional",
    innerType: e
  });
}
const Oh = /* @__PURE__ */ E("ZodExactOptional", (e, t) => {
  cm.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => Js(e, r, n, o), e.unwrap = () => e._zod.def.innerType;
});
function Bh(e) {
  return new Oh({
    type: "optional",
    innerType: e
  });
}
const Fh = /* @__PURE__ */ E("ZodNullable", (e, t) => {
  dm.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => Tf(e, r, n, o), e.unwrap = () => e._zod.def.innerType;
});
function hi(e) {
  return new Fh({
    type: "nullable",
    innerType: e
  });
}
const Nh = /* @__PURE__ */ E("ZodDefault", (e, t) => {
  lm.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => Cf(e, r, n, o), e.unwrap = () => e._zod.def.innerType, e.removeDefault = e.unwrap;
});
function $h(e, t) {
  return new Nh({
    type: "default",
    innerType: e,
    get defaultValue() {
      return typeof t == "function" ? t() : zs(t);
    }
  });
}
const qh = /* @__PURE__ */ E("ZodPrefault", (e, t) => {
  um.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => Mf(e, r, n, o), e.unwrap = () => e._zod.def.innerType;
});
function Hh(e, t) {
  return new qh({
    type: "prefault",
    innerType: e,
    get defaultValue() {
      return typeof t == "function" ? t() : zs(t);
    }
  });
}
const ac = /* @__PURE__ */ E("ZodNonOptional", (e, t) => {
  pm.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => Rf(e, r, n, o), e.unwrap = () => e._zod.def.innerType;
});
function Lh(e, t) {
  return new ac({
    type: "nonoptional",
    innerType: e,
    ...F(t)
  });
}
const Uh = /* @__PURE__ */ E("ZodCatch", (e, t) => {
  mm.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => Df(e, r, n, o), e.unwrap = () => e._zod.def.innerType, e.removeCatch = e.unwrap;
});
function Zh(e, t) {
  return new Uh({
    type: "catch",
    innerType: e,
    catchValue: typeof t == "function" ? t : () => t
  });
}
const jh = /* @__PURE__ */ E("ZodPipe", (e, t) => {
  fm.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => Vf(e, r, n, o), e.in = t.in, e.out = t.out;
});
function Io(e, t) {
  return new jh({
    type: "pipe",
    in: e,
    out: t
    // ...util.normalizeParams(params),
  });
}
const Kh = /* @__PURE__ */ E("ZodReadonly", (e, t) => {
  hm.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => Of(e, r, n, o), e.unwrap = () => e._zod.def.innerType;
});
function Wh(e) {
  return new Kh({
    type: "readonly",
    innerType: e
  });
}
const ic = /* @__PURE__ */ E("ZodCustom", (e, t) => {
  gm.init(e, t), ge.init(e, t), e._zod.processJSONSchema = (r, n, o) => If(e, r);
});
function Gh(e, t) {
  return /* @__PURE__ */ df(ic, e ?? (() => !0), t);
}
function Qh(e, t = {}) {
  return /* @__PURE__ */ lf(ic, e, t);
}
function Jh(e) {
  return /* @__PURE__ */ uf(e);
}
function Xh(e, t) {
  return Io(nc(e), t);
}
const Yh = "automation:v2:", eg = (e, t) => `${Yh}${JSON.stringify([
  e.kind,
  e.kind === "track" ? e.trackId : null,
  e.effectInstanceId ?? null,
  t
])}`, tg = (e) => e === "linear" || e === "hold", rg = () => ({
  enabled: !0,
  fftSize: 2048,
  overlap: 4,
  mode: "freeze",
  freeze: 0,
  gateThresholdDb: -60,
  gateAttackMs: 10,
  gateReleaseMs: 100,
  morph: 0,
  binShift: 0,
  blur: 0,
  harmonicPercussiveBalance: 0,
  noiseReduction: 0,
  profileLearn: 0,
  mix: 1
}), gi = (e) => typeof e == "object" && e !== null && !Array.isArray(e) ? e : {}, Xe = (e, t, r, n) => typeof e == "number" && Number.isFinite(e) ? Math.min(n, Math.max(r, e)) : t, ng = (e) => e === 512 || e === 1024 || e === 2048 || e === 4096, og = (e) => e === 2 || e === 4, ag = (e) => e === "freeze" || e === "gate" || e === "morph" || e === "shift-blur" || e === "hpss" || e === "noise-reduce", ig = (e) => {
  const t = gi(e), r = gi(Reflect.get(t, "version") === 1 ? Reflect.get(t, "state") : e), n = rg();
  return {
    version: 1,
    state: {
      enabled: typeof Reflect.get(r, "enabled") == "boolean" ? Reflect.get(r, "enabled") : n.enabled,
      fftSize: ng(Reflect.get(r, "fftSize")) ? Reflect.get(r, "fftSize") : n.fftSize,
      overlap: og(Reflect.get(r, "overlap")) ? Reflect.get(r, "overlap") : n.overlap,
      mode: ag(Reflect.get(r, "mode")) ? Reflect.get(r, "mode") : n.mode,
      freeze: Xe(Reflect.get(r, "freeze"), n.freeze, 0, 1),
      gateThresholdDb: Xe(Reflect.get(r, "gateThresholdDb"), n.gateThresholdDb, -120, 0),
      gateAttackMs: Xe(Reflect.get(r, "gateAttackMs"), n.gateAttackMs, 0.1, 1e3),
      gateReleaseMs: Xe(Reflect.get(r, "gateReleaseMs"), n.gateReleaseMs, 1, 5e3),
      morph: Xe(Reflect.get(r, "morph"), n.morph, 0, 1),
      binShift: Xe(Reflect.get(r, "binShift"), n.binShift, -2048, 2048),
      blur: Xe(Reflect.get(r, "blur"), n.blur, 0, 1),
      harmonicPercussiveBalance: Xe(Reflect.get(r, "harmonicPercussiveBalance"), n.harmonicPercussiveBalance, -1, 1),
      noiseReduction: Xe(Reflect.get(r, "noiseReduction"), n.noiseReduction, 0, 1),
      profileLearn: Xe(Reflect.get(r, "profileLearn"), n.profileLearn, 0, 1),
      mix: Xe(Reflect.get(r, "mix"), n.mix, 0, 1)
    }
  };
}, sg = 20, cg = 2e4, dg = -24, lg = 24, ug = 0.2, pg = 18, Go = [40, 100, 200, 500, 1e3, 2500, 6e3, 12e3];
function W(e, t, r) {
  return Math.max(t, Math.min(r, e));
}
function G(e) {
  return typeof e == "number" && Number.isFinite(e) ? e : void 0;
}
function mg(e) {
  return e === 0 ? "lowshelf" : e === Go.length - 1 ? "highshelf" : "peaking";
}
function sc(e) {
  return {
    id: `b${e + 1}`,
    frequency: Go[e] ?? 1e3,
    gainDb: 0,
    q: 1,
    enabled: !0,
    type: mg(e)
  };
}
function fg() {
  return {
    bands: Go.map((e, t) => sc(t)),
    enabled: !0,
    channelMode: "stereo"
  };
}
function hg(e) {
  return e === "mono" ? "mono" : "stereo";
}
function cc(e) {
  return e === "allpass" || e === "bandpass" || e === "highpass" || e === "highshelf" || e === "lowpass" || e === "lowshelf" || e === "notch" || e === "peaking";
}
function gg(e) {
  const t = fg(), r = Array.isArray(e.bands) && e.bands.length > 0 ? e.bands : t.bands;
  return {
    enabled: typeof e.enabled == "boolean" ? e.enabled : t.enabled,
    channelMode: hg(e.channelMode),
    bands: r.map((n, o) => {
      const a = t.bands[o] ?? sc(o), i = G(n.frequency), s = G(n.gainDb), d = G(n.q);
      return {
        id: typeof n.id == "string" && n.id.length > 0 ? n.id : a.id,
        frequency: i === void 0 ? a.frequency : W(i, sg, cg),
        gainDb: s === void 0 ? a.gainDb : W(s, dg, lg),
        q: d === void 0 ? a.q : W(d, ug, pg),
        enabled: typeof n.enabled == "boolean" ? n.enabled : a.enabled,
        type: cc(n.type) ? n.type : a.type
      };
    })
  };
}
const yg = 0, bg = 1, vg = 0, kg = 250, wg = 0, Ig = 2;
function no() {
  return {
    enabled: !0,
    wet: 0.25,
    decaySec: 2.2,
    preDelayMs: 20,
    reflections: 0,
    reflectionSpin: !0,
    reflectionModAmountMs: 17.5,
    reflectionModRateHz: 0.3,
    reflectionShape: 0.5,
    diffuse: 1,
    size: 0.65,
    diffusion: 0.75,
    density: 0.8,
    lowCutHz: 20,
    highCutHz: 2e4,
    diffusionLowCutHz: 20,
    diffusionHighCutHz: 2e4,
    stereoWidth: 1
  };
}
const dc = 0, lc = 36, uc = -24, pc = 12, mc = 0, fc = 1, hc = 100, gc = 1e4, Sg = 0, xg = 1;
function zr() {
  return {
    enabled: !0,
    driveDb: 6,
    curve: "soft",
    color: !1,
    colorFrequencyHz: 1200,
    colorAmount: 0,
    outputDb: 0,
    dryWet: 1
  };
}
function yc(e) {
  return e === "soft" || e === "medium" || e === "hard" || e === "clip";
}
function Eg(e = {}) {
  const t = zr(), r = G(e.driveDb), n = G(e.colorFrequencyHz), o = G(e.colorAmount), a = G(e.outputDb), i = G(e.dryWet);
  return {
    enabled: typeof e.enabled == "boolean" ? e.enabled : t.enabled,
    driveDb: r === void 0 ? t.driveDb : W(r, dc, lc),
    curve: yc(e.curve) ? e.curve : t.curve,
    color: typeof e.color == "boolean" ? e.color : t.color,
    colorFrequencyHz: n === void 0 ? t.colorFrequencyHz : W(n, hc, gc),
    colorAmount: o === void 0 ? t.colorAmount : W(o, Sg, xg),
    outputDb: a === void 0 ? t.outputDb : W(a, uc, pc),
    dryWet: i === void 0 ? t.dryWet : W(i, mc, fc)
  };
}
const bc = 1, vc = 2e3, kc = 0, wc = 0.95, Ic = 0, Sc = 1, xc = 20, Ec = 2e3, Pc = 1e3, Ac = 2e4;
function rr() {
  return {
    enabled: !0,
    mode: "sync",
    timeMs: 250,
    syncDivision: "1/8",
    feedback: 0.25,
    dryWet: 0.2,
    pingPong: !1,
    filterEnabled: !1,
    lowCutHz: 120,
    highCutHz: 8e3
  };
}
function _c(e) {
  return e === "sync" || e === "time";
}
function zc(e) {
  return e === "1/16" || e === "1/8" || e === "1/4" || e === "1/2" || e === "1/1";
}
function Pg(e = {}) {
  const t = rr(), r = G(e.timeMs), n = G(e.feedback), o = G(e.dryWet), a = G(e.lowCutHz), i = G(e.highCutHz), s = a === void 0 ? t.lowCutHz : W(a, xc, Ec), d = i === void 0 ? t.highCutHz : W(i, Math.max(Pc, s + 1), Ac);
  return {
    enabled: typeof e.enabled == "boolean" ? e.enabled : t.enabled,
    mode: _c(e.mode) ? e.mode : t.mode,
    timeMs: r === void 0 ? t.timeMs : W(r, bc, vc),
    syncDivision: zc(e.syncDivision) ? e.syncDivision : t.syncDivision,
    feedback: n === void 0 ? t.feedback : W(n, kc, wc),
    dryWet: o === void 0 ? t.dryWet : W(o, Ic, Sc),
    pingPong: typeof e.pingPong == "boolean" ? e.pingPong : t.pingPong,
    filterEnabled: typeof e.filterEnabled == "boolean" ? e.filterEnabled : t.filterEnabled,
    lowCutHz: s,
    highCutHz: d
  };
}
const Ag = -60, _g = 0, zg = 1, Tg = 100, Rg = 0.1, Cg = 100, Mg = 5, Dg = 1e3, yi = -36, bi = 36, Vg = 0, Og = 1, Bg = 0, Fg = 24, Ng = 0, $g = 10, qg = 20, Hg = 2e4, Lg = 0.1, Ug = 18, Zg = {
  enabled: !1,
  filterType: "highpass",
  frequencyHz: 120,
  q: 0.707
}, jg = {
  enabled: !0,
  thresholdDb: -24,
  ratio: 4,
  attackMs: 10,
  releaseMs: 120,
  autoRelease: !0,
  makeupDb: 0,
  outputDb: 0,
  dryWet: 1,
  kneeDb: 6,
  lookaheadMs: 0,
  detectorMode: "rms",
  dynamicsMode: "compress",
  envelopeCurve: "log"
};
function Tc(e) {
  return e === "peak" || e === "rms";
}
function Rc(e) {
  return e === "compress" || e === "expand";
}
function Cc(e) {
  return e === "log" || e === "linear";
}
function Mc(e) {
  return e === "lowpass" || e === "highpass" || e === "bandpass";
}
function Kg(e) {
  const t = Zg, r = G(e?.frequencyHz), n = G(e?.q);
  return {
    enabled: typeof e?.enabled == "boolean" ? e.enabled : t.enabled,
    filterType: Mc(e?.filterType) ? e.filterType : t.filterType,
    frequencyHz: r === void 0 ? t.frequencyHz : W(r, qg, Hg),
    q: n === void 0 ? t.q : W(n, Lg, Ug)
  };
}
function Wg(e = {}) {
  const t = jg, r = G(e.thresholdDb), n = G(e.ratio), o = G(e.attackMs), a = G(e.releaseMs), i = G(e.makeupDb), s = G(e.outputDb), d = G(e.dryWet), m = G(e.kneeDb), h = G(e.lookaheadMs);
  return {
    enabled: typeof e.enabled == "boolean" ? e.enabled : t.enabled,
    thresholdDb: r === void 0 ? t.thresholdDb : W(r, Ag, _g),
    ratio: n === void 0 ? t.ratio : W(n, zg, Tg),
    attackMs: o === void 0 ? t.attackMs : W(o, Rg, Cg),
    releaseMs: a === void 0 ? t.releaseMs : W(a, Mg, Dg),
    autoRelease: typeof e.autoRelease == "boolean" ? e.autoRelease : t.autoRelease,
    makeupDb: i === void 0 ? t.makeupDb : W(i, yi, bi),
    outputDb: s === void 0 ? t.outputDb : W(s, yi, bi),
    dryWet: d === void 0 ? t.dryWet : W(d, Vg, Og),
    kneeDb: m === void 0 ? t.kneeDb : W(m, Bg, Fg),
    lookaheadMs: h === void 0 ? t.lookaheadMs : W(h, Ng, $g),
    detectorMode: Tc(e.detectorMode) ? e.detectorMode : t.detectorMode,
    dynamicsMode: Rc(e.dynamicsMode) ? e.dynamicsMode : t.dynamicsMode,
    envelopeCurve: Cc(e.envelopeCurve) ? e.envelopeCurve : t.envelopeCurve,
    sidechain: Kg(e.sidechain)
  };
}
const Gg = (e) => typeof e == "object" && e !== null && !Array.isArray(e), De = (e) => Gg(e) ? e : {};
function Dc() {
  return { enabled: !0, gainDb: 0, polarity: "normal", inputMode: "stereo", pan: 0, balance: 0, width: 1, matrix: "stereo", swap: !1, dcBlock: !0 };
}
function Vc(e = {}) {
  const t = Dc(), r = G(e.gainDb), n = G(e.pan), o = G(e.balance), a = G(e.width);
  return {
    enabled: typeof e.enabled == "boolean" ? e.enabled : t.enabled,
    gainDb: r === void 0 ? t.gainDb : W(r, -60, 24),
    polarity: e.polarity === "invert" ? "invert" : "normal",
    inputMode: e.inputMode === "mono-sum" ? "mono-sum" : "stereo",
    pan: n === void 0 ? t.pan : W(n, -1, 1),
    balance: o === void 0 ? t.balance : W(o, -1, 1),
    width: a === void 0 ? t.width : W(a, 0, 2),
    matrix: e.matrix === "mid-side-encode" || e.matrix === "mid-side-decode" ? e.matrix : "stereo",
    swap: typeof e.swap == "boolean" ? e.swap : t.swap,
    dcBlock: typeof e.dcBlock == "boolean" ? e.dcBlock : t.dcBlock
  };
}
const Qg = (e) => JSON.stringify({ version: 1, state: Vc(e) }), Jg = (e) => {
  const t = De(e), r = De(t.version === 1 ? t.state : e);
  return {
    version: 1,
    state: Vc({
      enabled: r.enabled === !0 || r.enabled === !1 ? r.enabled : void 0,
      gainDb: typeof r.gainDb == "number" ? r.gainDb : void 0,
      polarity: r.polarity,
      inputMode: r.inputMode,
      pan: typeof r.pan == "number" ? r.pan : void 0,
      balance: typeof r.balance == "number" ? r.balance : void 0,
      width: typeof r.width == "number" ? r.width : void 0,
      matrix: r.matrix,
      swap: r.swap === !0 || r.swap === !1 ? r.swap : void 0,
      dcBlock: r.dcBlock === !0 || r.dcBlock === !1 ? r.dcBlock : void 0
    })
  };
};
function Oc() {
  return { enabled: !0, mode: "gate", thresholdDb: -40, ratio: 4, attackMs: 1, holdMs: 20, releaseMs: 120, hysteresisDb: 6, rangeDb: -80, lookaheadMs: 0, detector: "peak", link: 1, sidechain: { enabled: !1, filterType: "highpass", frequencyHz: 80, q: 0.707 } };
}
function Bc(e = {}) {
  const t = Oc(), r = (n, o, a, i) => {
    const s = G(n);
    return s === void 0 ? o : W(s, a, i);
  };
  return {
    enabled: typeof e.enabled == "boolean" ? e.enabled : t.enabled,
    mode: e.mode === "expander" ? "expander" : "gate",
    thresholdDb: r(e.thresholdDb, t.thresholdDb, -80, 0),
    ratio: r(e.ratio, t.ratio, 1, 20),
    attackMs: r(e.attackMs, t.attackMs, 0.1, 100),
    holdMs: r(e.holdMs, t.holdMs, 0, 500),
    releaseMs: r(e.releaseMs, t.releaseMs, 5, 2e3),
    hysteresisDb: r(e.hysteresisDb, t.hysteresisDb, 0, 24),
    rangeDb: r(e.rangeDb, t.rangeDb, -80, 0),
    lookaheadMs: r(e.lookaheadMs, t.lookaheadMs, 0, 2),
    detector: e.detector === "rms" ? "rms" : "peak",
    link: r(e.link, t.link, 0, 1),
    sidechain: {
      enabled: typeof e.sidechain?.enabled == "boolean" ? e.sidechain.enabled : t.sidechain.enabled,
      filterType: "highpass",
      frequencyHz: r(e.sidechain?.frequencyHz, t.sidechain.frequencyHz, 20, 2e4),
      q: r(e.sidechain?.q, t.sidechain.q, 0.1, 18)
    }
  };
}
const Xg = (e) => JSON.stringify({ version: 1, state: Bc(e) }), Yg = (e) => {
  const t = De(e), r = De(t.version === 1 ? t.state : e), n = De(r.sidechain);
  return {
    version: 1,
    state: Bc({
      enabled: r.enabled === !0 || r.enabled === !1 ? r.enabled : void 0,
      mode: r.mode,
      thresholdDb: typeof r.thresholdDb == "number" ? r.thresholdDb : void 0,
      ratio: typeof r.ratio == "number" ? r.ratio : void 0,
      attackMs: typeof r.attackMs == "number" ? r.attackMs : void 0,
      holdMs: typeof r.holdMs == "number" ? r.holdMs : void 0,
      releaseMs: typeof r.releaseMs == "number" ? r.releaseMs : void 0,
      hysteresisDb: typeof r.hysteresisDb == "number" ? r.hysteresisDb : void 0,
      rangeDb: typeof r.rangeDb == "number" ? r.rangeDb : void 0,
      lookaheadMs: typeof r.lookaheadMs == "number" ? r.lookaheadMs : void 0,
      detector: r.detector,
      link: typeof r.link == "number" ? r.link : void 0,
      sidechain: {
        enabled: n.enabled === !0 || n.enabled === !1 ? n.enabled : void 0,
        frequencyHz: typeof n.frequencyHz == "number" ? n.frequencyHz : void 0,
        q: typeof n.q == "number" ? n.q : void 0
      }
    })
  };
};
function Fc() {
  return { enabled: !0, ceilingDbtp: -1, releaseMs: 100, lookaheadMs: 5, link: 1, detectorOversampling: 4 };
}
function Nc(e = {}) {
  const t = Fc(), r = G(e.ceilingDbtp), n = G(e.releaseMs), o = G(e.lookaheadMs), a = G(e.link);
  return {
    enabled: typeof e.enabled == "boolean" ? e.enabled : t.enabled,
    ceilingDbtp: r === void 0 ? t.ceilingDbtp : W(r, -12, 0),
    releaseMs: n === void 0 ? t.releaseMs : W(n, 20, 1e3),
    lookaheadMs: o === void 0 ? t.lookaheadMs : W(o, 1, 5),
    link: a === void 0 ? t.link : W(a, 0, 1),
    detectorOversampling: 4
  };
}
const ey = (e) => JSON.stringify({ version: 1, state: Nc(e) }), ty = (e) => {
  const t = De(e), r = De(t.version === 1 ? t.state : e);
  return {
    version: 1,
    state: Nc({
      enabled: r.enabled === !0 || r.enabled === !1 ? r.enabled : void 0,
      ceilingDbtp: typeof r.ceilingDbtp == "number" ? r.ceilingDbtp : void 0,
      releaseMs: typeof r.releaseMs == "number" ? r.releaseMs : void 0,
      lookaheadMs: typeof r.lookaheadMs == "number" ? r.lookaheadMs : void 0,
      link: typeof r.link == "number" ? r.link : void 0,
      detectorOversampling: r.detectorOversampling
    })
  };
};
function or() {
  return {
    enabled: !0,
    mode: "lowpass",
    frequencyHz: 1e3,
    resonance: 0.25,
    driveDb: 0,
    mix: 1,
    envelope: { amountOctaves: 0, attackMs: 10, releaseMs: 100 },
    lfo: { waveform: "sine", rateHz: 1, depthOctaves: 0, phaseOffset: 0, stereoPhase: 0 },
    quality: "2x"
  };
}
function $c(e = {}) {
  const t = or(), r = (o, a, i, s) => {
    const d = G(o);
    return d === void 0 ? a : W(d, i, s);
  }, n = e.mode;
  return {
    enabled: typeof e.enabled == "boolean" ? e.enabled : t.enabled,
    mode: n === "highpass" || n === "bandpass" || n === "notch" || n === "peak" ? n : "lowpass",
    frequencyHz: r(e.frequencyHz, t.frequencyHz, 20, 2e4),
    resonance: r(e.resonance, t.resonance, 0, 1),
    driveDb: r(e.driveDb, t.driveDb, 0, 24),
    mix: r(e.mix, t.mix, 0, 1),
    envelope: {
      amountOctaves: r(e.envelope?.amountOctaves, t.envelope.amountOctaves, -6, 6),
      attackMs: r(e.envelope?.attackMs, t.envelope.attackMs, 0.5, 500),
      releaseMs: r(e.envelope?.releaseMs, t.envelope.releaseMs, 5, 2e3)
    },
    lfo: {
      waveform: e.lfo?.waveform === "triangle" ? "triangle" : "sine",
      rateHz: r(e.lfo?.rateHz, t.lfo.rateHz, 0.01, 20),
      depthOctaves: r(e.lfo?.depthOctaves, t.lfo.depthOctaves, 0, 6),
      phaseOffset: r(e.lfo?.phaseOffset, t.lfo.phaseOffset, 0, 1),
      stereoPhase: r(e.lfo?.stereoPhase, t.lfo.stereoPhase, -0.5, 0.5)
    },
    quality: "2x"
  };
}
const ry = (e) => JSON.stringify({ version: 1, state: $c(e) }), ny = (e) => {
  const t = De(e), r = De(t.version === 1 ? t.state : e), n = De(r.envelope), o = De(r.lfo);
  return {
    version: 1,
    state: $c({
      enabled: r.enabled === !0 || r.enabled === !1 ? r.enabled : void 0,
      mode: r.mode,
      frequencyHz: typeof r.frequencyHz == "number" ? r.frequencyHz : void 0,
      resonance: typeof r.resonance == "number" ? r.resonance : void 0,
      driveDb: typeof r.driveDb == "number" ? r.driveDb : void 0,
      mix: typeof r.mix == "number" ? r.mix : void 0,
      envelope: {
        amountOctaves: typeof n.amountOctaves == "number" ? n.amountOctaves : void 0,
        attackMs: typeof n.attackMs == "number" ? n.attackMs : void 0,
        releaseMs: typeof n.releaseMs == "number" ? n.releaseMs : void 0
      },
      lfo: {
        waveform: o.waveform,
        rateHz: typeof o.rateHz == "number" ? o.rateHz : void 0,
        depthOctaves: typeof o.depthOctaves == "number" ? o.depthOctaves : void 0,
        phaseOffset: typeof o.phaseOffset == "number" ? o.phaseOffset : void 0,
        stereoPhase: typeof o.stereoPhase == "number" ? o.stereoPhase : void 0
      },
      quality: r.quality
    })
  };
}, Y = (e, t, r, n) => typeof e == "number" && Number.isFinite(e) ? W(e, r, n) : t, jr = (e, t) => {
  const r = De(e);
  return { version: 1, state: t(De(r.version === 1 ? r.state : e)) };
}, qc = () => ({ enabled: !0, delayMs: 12, depthMs: 4, rateHz: 0.8, feedback: 0, stereoPhase: 0.25, mix: 0.35 }), Hc = () => ({ enabled: !0, delayMs: 1.5, depthMs: 1, rateHz: 0.2, feedback: 0.35, stereoPhase: 0.5, mix: 0.5 }), Lc = () => ({ enabled: !0, stages: 6, centerHz: 1e3, depthOctaves: 3, rateHz: 0.3, feedback: 0.3, stereoPhase: 0.5, mix: 0.5 }), Uc = () => ({ enabled: !0, waveform: "sine", rateHz: 4, depth: 0.5, shape: 0.5, phase: 0 }), Zc = () => ({ enabled: !0, waveform: "sine", rateHz: 1, depth: 1, shape: 0.5, phase: 0 }), jc = () => ({ enabled: !0, voices: 3, delayMs: 18, depthMs: 6, rateHz: 0.6, spread: 1, mix: 0.5 }), vi = (e) => jr(e, (t) => {
  const r = qc();
  return { enabled: typeof t.enabled == "boolean" ? t.enabled : !0, delayMs: Y(t.delayMs, r.delayMs, 5, 30), depthMs: Y(t.depthMs, r.depthMs, 0, 10), rateHz: Y(t.rateHz, r.rateHz, 0.01, 20), feedback: Y(t.feedback, r.feedback, 0, 0.5), stereoPhase: Y(t.stereoPhase, r.stereoPhase, -0.5, 0.5), mix: Y(t.mix, r.mix, 0, 1) };
}), ki = (e) => jr(e, (t) => {
  const r = Hc();
  return { enabled: typeof t.enabled == "boolean" ? t.enabled : !0, delayMs: Y(t.delayMs, r.delayMs, 0.1, 10), depthMs: Y(t.depthMs, r.depthMs, 0, 5), rateHz: Y(t.rateHz, r.rateHz, 0.01, 20), feedback: Y(t.feedback, r.feedback, -0.95, 0.95), stereoPhase: Y(t.stereoPhase, r.stereoPhase, -0.5, 0.5), mix: Y(t.mix, r.mix, 0, 1) };
}), wi = (e) => jr(e, (t) => {
  const r = Lc();
  return { enabled: typeof t.enabled == "boolean" ? t.enabled : !0, stages: t.stages === 4 || t.stages === 6 || t.stages === 8 || t.stages === 12 ? t.stages : r.stages, centerHz: Y(t.centerHz, r.centerHz, 100, 8e3), depthOctaves: Y(t.depthOctaves, r.depthOctaves, 0, 5), rateHz: Y(t.rateHz, r.rateHz, 0.01, 20), feedback: Y(t.feedback, r.feedback, -0.95, 0.95), stereoPhase: Y(t.stereoPhase, r.stereoPhase, -0.5, 0.5), mix: Y(t.mix, r.mix, 0, 1) };
}), Kc = (e, t) => jr(e, (r) => ({ enabled: typeof r.enabled == "boolean" ? r.enabled : !0, waveform: r.waveform === "triangle" ? "triangle" : "sine", rateHz: Y(r.rateHz, t.rateHz, 0.01, 20), depth: Y(r.depth, t.depth, 0, 1), shape: Y(r.shape, t.shape, 0, 1), phase: Y(r.phase, t.phase, 0, 1) })), Ii = (e) => Kc(e, Uc()), Si = (e) => Kc(e, Zc()), xi = (e) => jr(e, (t) => {
  const r = jc();
  return { enabled: typeof t.enabled == "boolean" ? t.enabled : !0, voices: 3, delayMs: Y(t.delayMs, r.delayMs, 10, 30), depthMs: Y(t.depthMs, r.depthMs, 1, 12), rateHz: Y(t.rateHz, r.rateHz, 0.05, 5), spread: Y(t.spread, r.spread, 0, 1), mix: Y(t.mix, r.mix, 0, 1) };
}), Wc = () => ({
  enabled: !0,
  bitDepth: 12,
  sampleRateRatio: 1,
  jitter: 0,
  noiseDb: -80,
  quantization: "round",
  dither: "off",
  mix: 1,
  seed: 1
}), Ei = (e) => {
  const t = De(e), r = De(t.version === 1 ? t.state : e), n = Wc(), o = Y(r.seed, n.seed, 1, 4294967295);
  return {
    version: 1,
    state: {
      enabled: typeof r.enabled == "boolean" ? r.enabled : n.enabled,
      bitDepth: Math.round(Y(r.bitDepth, n.bitDepth, 2, 24)),
      sampleRateRatio: Y(r.sampleRateRatio, n.sampleRateRatio, 0.01, 1),
      jitter: Y(r.jitter, n.jitter, 0, 1),
      noiseDb: Y(r.noiseDb, n.noiseDb, -120, -24),
      quantization: r.quantization === "floor" || r.quantization === "truncate" ? r.quantization : "round",
      dither: r.dither === "rectangular" || r.dither === "triangular" ? r.dither : "off",
      mix: Y(r.mix, n.mix, 0, 1),
      seed: Math.max(1, Math.round(o)) >>> 0
    }
  };
}, Ae = {
  utility: {
    kind: "utility",
    masterKind: "master-utility",
    createDefaultParams: () => ({ version: 1, state: Dc() }),
    normalizeParams: Jg,
    serializeParams: (e) => Qg(e.state)
  },
  autofilter: {
    kind: "autofilter",
    masterKind: "master-autofilter",
    createDefaultParams: () => ({ version: 1, state: or() }),
    normalizeParams: ny,
    serializeParams: (e) => ry(e.state)
  },
  gate: {
    kind: "gate",
    masterKind: "master-gate",
    createDefaultParams: () => ({ version: 1, state: Oc() }),
    normalizeParams: Yg,
    serializeParams: (e) => Xg(e.state)
  },
  limiter: {
    kind: "limiter",
    masterKind: "master-limiter",
    createDefaultParams: () => ({ version: 1, state: Fc() }),
    normalizeParams: ty,
    serializeParams: (e) => ey(e.state)
  },
  lofi: {
    kind: "lofi",
    masterKind: "master-lofi",
    createDefaultParams: () => ({ version: 1, state: Wc() }),
    normalizeParams: Ei,
    serializeParams: (e) => JSON.stringify(Ei(e))
  },
  chorus: { kind: "chorus", masterKind: "master-chorus", createDefaultParams: () => ({ version: 1, state: qc() }), normalizeParams: vi, serializeParams: (e) => JSON.stringify(vi(e)) },
  flanger: { kind: "flanger", masterKind: "master-flanger", createDefaultParams: () => ({ version: 1, state: Hc() }), normalizeParams: ki, serializeParams: (e) => JSON.stringify(ki(e)) },
  phaser: { kind: "phaser", masterKind: "master-phaser", createDefaultParams: () => ({ version: 1, state: Lc() }), normalizeParams: wi, serializeParams: (e) => JSON.stringify(wi(e)) },
  tremolo: { kind: "tremolo", masterKind: "master-tremolo", createDefaultParams: () => ({ version: 1, state: Uc() }), normalizeParams: Ii, serializeParams: (e) => JSON.stringify(Ii(e)) },
  autopan: { kind: "autopan", masterKind: "master-autopan", createDefaultParams: () => ({ version: 1, state: Zc() }), normalizeParams: Si, serializeParams: (e) => JSON.stringify(Si(e)) },
  ensemble: { kind: "ensemble", masterKind: "master-ensemble", createDefaultParams: () => ({ version: 1, state: jc() }), normalizeParams: xi, serializeParams: (e) => JSON.stringify(xi(e)) }
}, oy = ["utility", "eq", "autofilter", "gate", "compressor", "saturator", "limiter", "lofi", "chorus", "flanger", "phaser", "tremolo", "autopan", "ensemble", "delay", "reverb", "spectral"], ay = oy;
function mr(e) {
  return ay.some((t) => e === t);
}
function iy(e) {
  return typeof e == "object" && e !== null && !Array.isArray(e) && "id" in e && "kind" in e && typeof e.id == "string" && mr(e.kind);
}
const Gc = 1, te = (e, t, r) => Math.max(t, Math.min(r, e)), re = (e, t) => typeof e == "number" && Number.isFinite(e) ? e : t, Tr = (e) => typeof e == "object" && e !== null && !Array.isArray(e);
function Qc() {
  return {
    version: Gc,
    zones: [],
    ampEnvelope: { attackSec: 5e-3, decaySec: 0.1, sustain: 1, releaseSec: 0.12, amount: 1 },
    filterEnvelope: { attackSec: 5e-3, decaySec: 0.15, sustain: 0, releaseSec: 0.15, amount: 0 },
    filterMode: "lowpass",
    filterFrequencyHz: 2e4,
    filterQ: 0.7,
    lfo: { enabled: !1, frequencyHz: 5, pitchCents: 0, filterHz: 0, amp: 0, pan: 0 },
    polyphony: 32,
    retrigger: !0,
    cachePolicy: "preload",
    maxDecodedBytes: 256 * 1024 * 1024
  };
}
const Pi = (e, t) => Tr(e) ? {
  attackSec: te(re(e.attackSec, t.attackSec), 0, 60),
  decaySec: te(re(e.decaySec, t.decaySec), 0, 60),
  sustain: te(re(e.sustain, t.sustain), 0, 1),
  releaseSec: te(re(e.releaseSec, t.releaseSec), 0, 60),
  amount: te(re(e.amount, t.amount), -1, 1)
} : t, sy = (e, t) => {
  if (!Tr(e) || !Tr(e.sample) || typeof e.sample.assetKey != "string" || typeof e.sample.url != "string") return;
  const r = Tr(e.sample.source) ? e.sample.source : void 0;
  if (!r || typeof r.durationSec != "number" || typeof r.sampleRate != "number" || typeof r.channelCount != "number") return;
  const n = e.sample.sourceKind;
  if (n !== "upload" && n !== "url" && n !== "recording") return;
  const o = te(re(e.startSec, 0), 0, r.durationSec), a = te(re(e.endSec, r.durationSec), o, r.durationSec), i = e.playbackMode === "forward-loop" || e.playbackMode === "crossfade-loop" ? e.playbackMode : "one-shot", s = te(re(e.loopStartSec, o), o, a), d = te(re(e.loopEndSec, a), s, a), m = Math.max(0, (d - s) / 2);
  return {
    id: typeof e.id == "string" && e.id ? e.id : `zone-${t}`,
    sample: {
      assetKey: e.sample.assetKey,
      url: e.sample.url,
      name: typeof e.sample.name == "string" ? e.sample.name : void 0,
      sourceKind: n,
      source: { durationSec: r.durationSec, sampleRate: r.sampleRate, channelCount: r.channelCount }
    },
    keyLow: Math.round(te(re(e.keyLow, 0), 0, 127)),
    keyHigh: Math.round(te(re(e.keyHigh, 127), 0, 127)),
    velocityLow: Math.round(te(re(e.velocityLow, 1), 1, 127)),
    velocityHigh: Math.round(te(re(e.velocityHigh, 127), 1, 127)),
    rootNote: Math.round(te(re(e.rootNote, 60), 0, 127)),
    tuneCents: te(re(e.tuneCents, 0), -4800, 4800),
    gain: te(re(e.gain, 1), 0, 4),
    pan: te(re(e.pan, 0), -1, 1),
    roundRobinGroup: Math.round(te(re(e.roundRobinGroup, 0), 0, 128)),
    roundRobinIndex: Math.round(te(re(e.roundRobinIndex, 0), 0, 128)),
    playbackMode: i,
    startSec: o,
    endSec: a,
    loopStartSec: i === "one-shot" ? void 0 : s,
    loopEndSec: i === "one-shot" ? void 0 : d,
    crossfadeSec: i === "crossfade-loop" ? te(re(e.crossfadeSec, 0.01), 0, m) : 0,
    chokeGroup: Math.round(te(re(e.chokeGroup, 0), 0, 128))
  };
};
function cy(e) {
  const t = Qc(), r = (e.zones ?? []).flatMap((a, i) => {
    const s = sy(a, i);
    return s && s.keyLow <= s.keyHigh && s.velocityLow <= s.velocityHigh ? [s] : [];
  }), n = e.filterMode === "highpass" || e.filterMode === "bandpass" || e.filterMode === "notch" ? e.filterMode : "lowpass", o = Tr(e.lfo) ? e.lfo : {};
  return {
    version: Gc,
    zones: r,
    ampEnvelope: Pi(e.ampEnvelope, t.ampEnvelope),
    filterEnvelope: Pi(e.filterEnvelope, t.filterEnvelope),
    filterMode: n,
    filterFrequencyHz: te(re(e.filterFrequencyHz, t.filterFrequencyHz), 20, 2e4),
    filterQ: te(re(e.filterQ, t.filterQ), 1e-4, 30),
    lfo: {
      enabled: typeof o.enabled == "boolean" ? o.enabled : t.lfo.enabled,
      frequencyHz: te(re(o.frequencyHz, t.lfo.frequencyHz), 0.01, 100),
      pitchCents: te(re(o.pitchCents, t.lfo.pitchCents), -2400, 2400),
      filterHz: te(re(o.filterHz, t.lfo.filterHz), -2e4, 2e4),
      amp: te(re(o.amp, t.lfo.amp), 0, 1),
      pan: te(re(o.pan, t.lfo.pan), 0, 1)
    },
    polyphony: Math.round(te(re(e.polyphony, t.polyphony), 1, 128)),
    retrigger: typeof e.retrigger == "boolean" ? e.retrigger : t.retrigger,
    cachePolicy: e.cachePolicy === "lazy" ? "lazy" : "preload",
    maxDecodedBytes: Math.round(te(re(e.maxDecodedBytes, t.maxDecodedBytes), 1024 * 1024, 2 * 1024 * 1024 * 1024))
  };
}
const Le = Qc(), Jc = {
  "output.gain": { defaultValue: 1, min: 0, max: 4, unit: "ratio", rate: "a-rate" },
  "output.pan": { defaultValue: 0, min: -1, max: 1, unit: "ratio", rate: "a-rate" },
  "amp.attack": { defaultValue: Le.ampEnvelope.attackSec, min: 0, max: 60, unit: "seconds", rate: "note" },
  "amp.decay": { defaultValue: Le.ampEnvelope.decaySec, min: 0, max: 60, unit: "seconds", rate: "note" },
  "amp.sustain": { defaultValue: Le.ampEnvelope.sustain, min: 0, max: 1, unit: "ratio", rate: "note" },
  "amp.release": { defaultValue: Le.ampEnvelope.releaseSec, min: 0, max: 60, unit: "seconds", rate: "note" },
  "filter.frequency": { defaultValue: Le.filterFrequencyHz, min: 20, max: 2e4, unit: "hz", rate: "a-rate" },
  "filter.q": { defaultValue: Le.filterQ, min: 1e-4, max: 30, unit: "ratio", rate: "a-rate" },
  "filter.envAmount": { defaultValue: Le.filterEnvelope.amount, min: -1, max: 1, unit: "ratio", rate: "note" },
  "lfo.rate": { defaultValue: Le.lfo.frequencyHz, min: 0.01, max: 100, unit: "hz", rate: "a-rate" },
  "lfo.pitchDepth": { defaultValue: Le.lfo.pitchCents, min: -2400, max: 2400, unit: "cents", rate: "a-rate" },
  "lfo.filterDepth": { defaultValue: Le.lfo.filterHz, min: -2e4, max: 2e4, unit: "hz", rate: "a-rate" },
  "lfo.ampDepth": { defaultValue: Le.lfo.amp, min: 0, max: 1, unit: "ratio", rate: "a-rate" },
  "lfo.panDepth": { defaultValue: Le.lfo.pan, min: 0, max: 1, unit: "ratio", rate: "a-rate" }
}, dy = (e) => Object.hasOwn(Jc, e), ly = (e) => {
  const t = e.split(":");
  if (t.length < 4 || t[0] !== "instrument" || !t[1]) return;
  const r = t.at(-1), n = t.slice(2, -1).join(":");
  if (!(!r || !n) && dy(r))
    return { kind: "instrument", trackId: t[1], instanceId: n, parameterId: r };
}, Xc = 1, uy = 128, nt = (e, t) => typeof e == "number" && Number.isFinite(e) ? e : t, ot = (e, t, r) => Math.max(t, Math.min(r, e));
function Yc() {
  return {
    version: Xc,
    grainSizeMs: 80,
    densityHz: 12,
    position: 0.5,
    spray: 0.1,
    pitchSemitones: 0,
    reverseProbability: 0,
    windowShape: "hann",
    stereoSpread: 0.5,
    freeze: !1,
    seed: 1,
    maxGrains: 64,
    maxDecodedBytes: 64 * 1024 * 1024
  };
}
const py = (e) => {
  if (typeof e != "object" || e === null || !("sample" in e)) return !1;
  const t = e.sample;
  return typeof t == "object" && t !== null && "assetKey" in t && typeof t.assetKey == "string" && "url" in t && typeof t.url == "string";
};
function my(e) {
  const t = Yc();
  return {
    version: Xc,
    zone: py(e.zone) ? e.zone : void 0,
    grainSizeMs: ot(nt(e.grainSizeMs, t.grainSizeMs), 5, 1e3),
    densityHz: ot(nt(e.densityHz, t.densityHz), 0.25, 200),
    position: ot(nt(e.position, t.position), 0, 1),
    spray: ot(nt(e.spray, t.spray), 0, 1),
    pitchSemitones: ot(nt(e.pitchSemitones, t.pitchSemitones), -48, 48),
    reverseProbability: ot(nt(e.reverseProbability, t.reverseProbability), 0, 1),
    windowShape: e.windowShape === "tukey" || e.windowShape === "gaussian" ? e.windowShape : "hann",
    stereoSpread: ot(nt(e.stereoSpread, t.stereoSpread), 0, 1),
    freeze: e.freeze === !0,
    seed: Math.round(ot(nt(e.seed, t.seed), 1, 2147483647)),
    maxGrains: Math.round(ot(nt(e.maxGrains, t.maxGrains), 1, uy)),
    maxDecodedBytes: Math.round(ot(nt(e.maxDecodedBytes, t.maxDecodedBytes), 1024 * 1024, 256 * 1024 * 1024))
  };
}
const Nt = Yc(), ed = {
  grainSize: { defaultValue: Nt.grainSizeMs, min: 5, max: 1e3, unit: "milliseconds" },
  density: { defaultValue: Nt.densityHz, min: 0.25, max: 200, unit: "hz" },
  position: { defaultValue: Nt.position, min: 0, max: 1, unit: "ratio" },
  spray: { defaultValue: Nt.spray, min: 0, max: 1, unit: "ratio" },
  pitch: { defaultValue: Nt.pitchSemitones, min: -48, max: 48, unit: "semitones" },
  reverseProbability: { defaultValue: Nt.reverseProbability, min: 0, max: 1, unit: "ratio" },
  stereoSpread: { defaultValue: Nt.stereoSpread, min: 0, max: 1, unit: "ratio" }
}, fy = (e) => Object.hasOwn(ed, e), hy = (e) => {
  const t = e.split(":");
  if (t.length < 4 || t[0] !== "instrument" || !t[1]) return;
  const r = t.at(-1), n = t.slice(2, -1).join(":");
  if (!(!r || !n || !fy(r)))
    return { kind: "instrument", trackId: t[1], instanceId: n, parameterId: r };
}, Qo = 2, V = {
  envelopeSeconds: { min: 0, max: 60 },
  sustain: { min: 0, max: 1 },
  oscillatorOctave: { min: -3, max: 3 },
  oscillatorSemitone: { min: -12, max: 12 },
  oscillatorDetuneCents: { min: -100, max: 100 },
  oscillatorLevel: { min: 0, max: 1 },
  filterFrequencyHz: { min: 20, max: 2e4 },
  filterQ: { min: 1e-4, max: 30 },
  filterKeyTracking: { min: 0, max: 1 },
  filterEnvelopeAmountOctaves: { min: -6, max: 6 },
  lfoFrequencyHz: { min: 0.01, max: 100 },
  lfoPitchCents: { min: -1200, max: 1200 },
  lfoFilterOctaves: { min: -6, max: 6 },
  lfoAmp: { min: 0, max: 1 },
  lfoPan: { min: 0, max: 1 },
  noiseLevel: { min: 0, max: 1 },
  gain: { min: 0, max: 1.5 },
  pan: { min: -1, max: 1 },
  polyphony: { min: 1, max: 128 }
}, je = (e) => typeof e == "object" && e !== null && !Array.isArray(e), Rr = (e) => typeof e == "number" && Number.isFinite(e) ? e : void 0, td = (e, t, r) => Math.max(t, Math.min(r, e)), So = (e, t, r, n) => {
  const o = Rr(e);
  return o === void 0 ? t : td(Math.round(o), r, n);
}, Ee = (e, t, r, n) => {
  const o = Rr(e);
  return o === void 0 ? t : td(o, r, n);
}, pe = (e) => typeof e == "number" && Number.isFinite(e), Ct = (e) => e === "sine" || e === "square" || e === "sawtooth" || e === "triangle", rd = (e) => e === "lowpass" || e === "highpass" || e === "bandpass" || e === "notch", Vn = () => ({
  version: Qo,
  oscillators: [
    { enabled: !0, wave: "sawtooth", octave: 0, semitone: 0, detuneCents: -7, level: 0.7 },
    { enabled: !0, wave: "sawtooth", octave: 0, semitone: 0, detuneCents: 7, level: 0.45 }
  ],
  ampEnvelope: { attackSec: 5e-3, decaySec: 0.1, sustain: 0.8, releaseSec: 0.12 },
  filter: {
    enabled: !0,
    mode: "lowpass",
    frequencyHz: 12e3,
    q: 0.7,
    keyTracking: 0,
    envelopeAmountOctaves: 0,
    envelope: { attackSec: 5e-3, decaySec: 0.15, sustain: 0, releaseSec: 0.15 }
  },
  lfo: { enabled: !1, wave: "sine", frequencyHz: 5, pitchCents: 0, filterOctaves: 0, amp: 0, pan: 0 },
  noise: { enabled: !1, level: 0.25 },
  gain: 0.8,
  pan: 0,
  polyphony: 1,
  retrigger: !0
}), Ai = (e, t) => {
  const r = je(e) ? e : {};
  return {
    attackSec: Ee(r.attackSec, t.attackSec, V.envelopeSeconds.min, V.envelopeSeconds.max),
    decaySec: Ee(r.decaySec, t.decaySec, V.envelopeSeconds.min, V.envelopeSeconds.max),
    sustain: Ee(r.sustain, t.sustain, V.sustain.min, V.sustain.max),
    releaseSec: Ee(r.releaseSec, t.releaseSec, V.envelopeSeconds.min, V.envelopeSeconds.max)
  };
}, _i = (e, t) => {
  const r = je(e) ? e : {};
  return {
    enabled: typeof r.enabled == "boolean" ? r.enabled : t.enabled,
    wave: Ct(r.wave) ? r.wave : t.wave,
    octave: So(r.octave, t.octave, V.oscillatorOctave.min, V.oscillatorOctave.max),
    semitone: So(r.semitone, t.semitone, V.oscillatorSemitone.min, V.oscillatorSemitone.max),
    detuneCents: Ee(r.detuneCents, t.detuneCents, V.oscillatorDetuneCents.min, V.oscillatorDetuneCents.max),
    level: Ee(r.level, t.level, V.oscillatorLevel.min, V.oscillatorLevel.max)
  };
}, nd = (e) => {
  const t = Vn(), r = Array.isArray(e.oscillators) ? e.oscillators : [], n = je(e.filter) ? e.filter : {}, o = je(e.lfo) ? e.lfo : {}, a = je(e.noise) ? e.noise : {};
  return {
    version: Qo,
    oscillators: [
      _i(r[0], t.oscillators[0]),
      _i(r[1], t.oscillators[1])
    ],
    ampEnvelope: Ai(e.ampEnvelope, t.ampEnvelope),
    filter: {
      enabled: typeof n.enabled == "boolean" ? n.enabled : t.filter.enabled,
      mode: rd(n.mode) ? n.mode : t.filter.mode,
      frequencyHz: Ee(n.frequencyHz, t.filter.frequencyHz, V.filterFrequencyHz.min, V.filterFrequencyHz.max),
      q: Ee(n.q, t.filter.q, V.filterQ.min, V.filterQ.max),
      keyTracking: Ee(n.keyTracking, t.filter.keyTracking, V.filterKeyTracking.min, V.filterKeyTracking.max),
      envelopeAmountOctaves: Ee(n.envelopeAmountOctaves, t.filter.envelopeAmountOctaves, V.filterEnvelopeAmountOctaves.min, V.filterEnvelopeAmountOctaves.max),
      envelope: Ai(n.envelope, t.filter.envelope)
    },
    lfo: {
      enabled: typeof o.enabled == "boolean" ? o.enabled : t.lfo.enabled,
      wave: Ct(o.wave) ? o.wave : t.lfo.wave,
      frequencyHz: Ee(o.frequencyHz, t.lfo.frequencyHz, V.lfoFrequencyHz.min, V.lfoFrequencyHz.max),
      pitchCents: Ee(o.pitchCents, t.lfo.pitchCents, V.lfoPitchCents.min, V.lfoPitchCents.max),
      filterOctaves: Ee(o.filterOctaves, t.lfo.filterOctaves, V.lfoFilterOctaves.min, V.lfoFilterOctaves.max),
      amp: Ee(o.amp, t.lfo.amp, V.lfoAmp.min, V.lfoAmp.max),
      pan: Ee(o.pan, t.lfo.pan, V.lfoPan.min, V.lfoPan.max)
    },
    noise: {
      enabled: typeof a.enabled == "boolean" ? a.enabled : t.noise.enabled,
      level: Ee(a.level, t.noise.level, V.noiseLevel.min, V.noiseLevel.max)
    },
    gain: Ee(e.gain, t.gain, V.gain.min, V.gain.max),
    pan: Ee(e.pan, t.pan, V.pan.min, V.pan.max),
    polyphony: So(e.polyphony, t.polyphony, V.polyphony.min, V.polyphony.max),
    retrigger: typeof e.retrigger == "boolean" ? e.retrigger : t.retrigger
  };
}, gy = (e) => "wave1" in e || "wave2" in e || "attackMs" in e || "releaseMs" in e, zi = (e) => je(e) && pe(e.attackSec) && pe(e.decaySec) && pe(e.sustain) && pe(e.releaseSec), Ti = (e) => je(e) && (e.enabled === void 0 || typeof e.enabled == "boolean") && Ct(e.wave) && pe(e.octave) && pe(e.semitone) && pe(e.detuneCents) && pe(e.level), yy = (e) => je(e) && typeof e.enabled == "boolean" && pe(e.level), by = (e) => e.version === Qo && Array.isArray(e.oscillators) && e.oscillators.length === 2 && Ti(e.oscillators[0]) && Ti(e.oscillators[1]) && zi(e.ampEnvelope) && je(e.filter) && typeof e.filter.enabled == "boolean" && rd(e.filter.mode) && pe(e.filter.frequencyHz) && pe(e.filter.q) && pe(e.filter.keyTracking) && pe(e.filter.envelopeAmountOctaves) && zi(e.filter.envelope) && je(e.lfo) && typeof e.lfo.enabled == "boolean" && Ct(e.lfo.wave) && pe(e.lfo.frequencyHz) && pe(e.lfo.pitchCents) && pe(e.lfo.filterOctaves) && pe(e.lfo.amp) && pe(e.lfo.pan) && (e.noise === void 0 || yy(e.noise)) && pe(e.gain) && pe(e.pan) && pe(e.polyphony) && typeof e.retrigger == "boolean", vy = (e) => Ct(e.wave1) && Ct(e.wave2) && (e.gain === void 0 || pe(e.gain)) && (e.attackMs === void 0 || pe(e.attackMs)) && (e.releaseMs === void 0 || pe(e.releaseMs)), ky = (e) => je(e) && (by(e) || vy(e)) ? od(e) : void 0, wy = (e) => {
  const t = Vn();
  return nd({
    ...t,
    oscillators: [
      { ...t.oscillators[0], wave: e.wave1, detuneCents: 0, level: 0.5 },
      { ...t.oscillators[1], wave: e.wave2, detuneCents: 0, level: 0.5 }
    ],
    gain: e.gain,
    ampEnvelope: {
      ...t.ampEnvelope,
      attackSec: typeof e.attackMs == "number" ? e.attackMs / 1e3 : void 0,
      decaySec: 0,
      sustain: 1,
      releaseSec: typeof e.releaseMs == "number" ? e.releaseMs / 1e3 : void 0
    }
  });
}, od = (e) => je(e) ? gy(e) ? wy({
  wave1: Ct(e.wave1) ? e.wave1 : void 0,
  wave2: Ct(e.wave2) ? e.wave2 : void 0,
  gain: Rr(e.gain),
  attackMs: Rr(e.attackMs),
  releaseMs: Rr(e.releaseMs)
}) : nd(e) : Vn(), ye = Vn(), ad = {
  "output.gain": { defaultValue: ye.gain, ...V.gain, unit: "ratio", rate: "a-rate" },
  "output.pan": { defaultValue: ye.pan, ...V.pan, unit: "ratio", rate: "a-rate" },
  "osc1.level": { defaultValue: ye.oscillators[0].level, ...V.oscillatorLevel, unit: "ratio", rate: "a-rate" },
  "osc1.detune": { defaultValue: ye.oscillators[0].detuneCents, ...V.oscillatorDetuneCents, unit: "cents", rate: "a-rate" },
  "osc2.level": { defaultValue: ye.oscillators[1].level, ...V.oscillatorLevel, unit: "ratio", rate: "a-rate" },
  "osc2.detune": { defaultValue: ye.oscillators[1].detuneCents, ...V.oscillatorDetuneCents, unit: "cents", rate: "a-rate" },
  "noise.level": { defaultValue: ye.noise.level, ...V.noiseLevel, unit: "ratio", rate: "a-rate" },
  "amp.attack": { defaultValue: ye.ampEnvelope.attackSec, ...V.envelopeSeconds, unit: "seconds", rate: "note" },
  "amp.decay": { defaultValue: ye.ampEnvelope.decaySec, ...V.envelopeSeconds, unit: "seconds", rate: "note" },
  "amp.sustain": { defaultValue: ye.ampEnvelope.sustain, ...V.sustain, unit: "ratio", rate: "note" },
  "amp.release": { defaultValue: ye.ampEnvelope.releaseSec, ...V.envelopeSeconds, unit: "seconds", rate: "note" },
  "filter.frequency": { defaultValue: ye.filter.frequencyHz, ...V.filterFrequencyHz, unit: "hz", rate: "a-rate" },
  "filter.q": { defaultValue: ye.filter.q, ...V.filterQ, unit: "ratio", rate: "a-rate" },
  "filter.envAmount": { defaultValue: ye.filter.envelopeAmountOctaves, ...V.filterEnvelopeAmountOctaves, unit: "octaves", rate: "note" },
  "filter.attack": { defaultValue: ye.filter.envelope.attackSec, ...V.envelopeSeconds, unit: "seconds", rate: "note" },
  "filter.decay": { defaultValue: ye.filter.envelope.decaySec, ...V.envelopeSeconds, unit: "seconds", rate: "note" },
  "filter.sustain": { defaultValue: ye.filter.envelope.sustain, ...V.sustain, unit: "ratio", rate: "note" },
  "filter.release": { defaultValue: ye.filter.envelope.releaseSec, ...V.envelopeSeconds, unit: "seconds", rate: "note" },
  "lfo.rate": { defaultValue: ye.lfo.frequencyHz, ...V.lfoFrequencyHz, unit: "hz", rate: "a-rate" },
  "lfo.pitchDepth": { defaultValue: ye.lfo.pitchCents, ...V.lfoPitchCents, unit: "cents", rate: "a-rate" },
  "lfo.filterDepth": { defaultValue: ye.lfo.filterOctaves, ...V.lfoFilterOctaves, unit: "octaves", rate: "a-rate" },
  "lfo.ampDepth": { defaultValue: ye.lfo.amp, ...V.lfoAmp, unit: "ratio", rate: "a-rate" },
  "lfo.panDepth": { defaultValue: ye.lfo.pan, ...V.lfoPan, unit: "ratio", rate: "a-rate" }
}, Iy = (e) => Object.hasOwn(ad, e), Sy = (e) => {
  const t = e.split(":");
  if (t.length < 4 || t[0] !== "synth-instrument" || !t[1]) return;
  const r = t.at(-1);
  if (!r || !Iy(r)) return;
  if (t.length === 4)
    try {
      const o = decodeURIComponent(t[1]), a = decodeURIComponent(t[2]);
      return o && a ? { kind: "synth-instrument", trackId: o, instanceId: a, parameterId: r } : void 0;
    } catch {
      return;
    }
  const n = t.slice(2, -1).join(":");
  return n ? { kind: "synth-instrument", trackId: t[1], instanceId: n, parameterId: r } : void 0;
}, xy = (e, t, r) => Math.min(r, Math.max(t, e)), Ey = (e) => {
  const t = /^vst3:([^:]+):([0-9]+)$/.exec(e);
  return !t || !t[1] || !t[2] ? null : { instanceId: t[1], parameterId: Number(t[2]) };
}, Py = [
  { id: "volume", label: "Volume", group: "Mixer", device: "Mixer", owner: "mixer", targetKinds: ["track", "master"], min: 0, max: 1.5, defaultValue: 1, scale: "linear", unit: "percent" }
], _e = [
  { id: "utility.gainDb", label: "Utility Gain", group: "Audio Effects", device: "Utility", owner: "utility", targetKinds: ["track", "master"], min: -60, max: 24, defaultValue: 0, scale: "linear", unit: "db" },
  { id: "utility.pan", label: "Utility Pan", group: "Audio Effects", device: "Utility", owner: "utility", targetKinds: ["track", "master"], min: -1, max: 1, defaultValue: 0, scale: "linear" },
  { id: "utility.balance", label: "Utility Balance", group: "Audio Effects", device: "Utility", owner: "utility", targetKinds: ["track", "master"], min: -1, max: 1, defaultValue: 0, scale: "linear" },
  { id: "utility.width", label: "Utility Width", group: "Audio Effects", device: "Utility", owner: "utility", targetKinds: ["track", "master"], min: 0, max: 2, defaultValue: 1, scale: "linear" },
  { id: "autofilter.frequencyHz", label: "Auto Filter Frequency", group: "Audio Effects", device: "Auto Filter", owner: "autofilter", targetKinds: ["track", "master"], min: 20, max: 2e4, defaultValue: or().frequencyHz, scale: "log", unit: "hz" },
  { id: "autofilter.resonance", label: "Auto Filter Resonance", group: "Audio Effects", device: "Auto Filter", owner: "autofilter", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: or().resonance, scale: "linear" },
  { id: "autofilter.driveDb", label: "Auto Filter Drive", group: "Audio Effects", device: "Auto Filter", owner: "autofilter", targetKinds: ["track", "master"], min: 0, max: 24, defaultValue: or().driveDb, scale: "linear", unit: "db" },
  { id: "autofilter.mix", label: "Auto Filter Mix", group: "Audio Effects", device: "Auto Filter", owner: "autofilter", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: or().mix, scale: "linear", unit: "percent" },
  { id: "autofilter.envelope.amountOctaves", label: "Auto Filter Envelope Amount", group: "Audio Effects", device: "Auto Filter", owner: "autofilter", targetKinds: ["track", "master"], min: -6, max: 6, defaultValue: 0, scale: "linear" },
  { id: "autofilter.envelope.attackMs", label: "Auto Filter Envelope Attack", group: "Audio Effects", device: "Auto Filter", owner: "autofilter", targetKinds: ["track", "master"], min: 0.5, max: 500, defaultValue: 10, scale: "linear" },
  { id: "autofilter.envelope.releaseMs", label: "Auto Filter Envelope Release", group: "Audio Effects", device: "Auto Filter", owner: "autofilter", targetKinds: ["track", "master"], min: 5, max: 2e3, defaultValue: 100, scale: "linear" },
  { id: "autofilter.lfo.rateHz", label: "Auto Filter LFO Rate", group: "Audio Effects", device: "Auto Filter", owner: "autofilter", targetKinds: ["track", "master"], min: 0.01, max: 20, defaultValue: 1, scale: "log", unit: "hz" },
  { id: "autofilter.lfo.depthOctaves", label: "Auto Filter LFO Depth", group: "Audio Effects", device: "Auto Filter", owner: "autofilter", targetKinds: ["track", "master"], min: 0, max: 6, defaultValue: 0, scale: "linear" },
  { id: "autofilter.lfo.phaseOffset", label: "Auto Filter LFO Phase", group: "Audio Effects", device: "Auto Filter", owner: "autofilter", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 0, scale: "linear" },
  { id: "autofilter.lfo.stereoPhase", label: "Auto Filter LFO Stereo Phase", group: "Audio Effects", device: "Auto Filter", owner: "autofilter", targetKinds: ["track", "master"], min: -0.5, max: 0.5, defaultValue: 0, scale: "linear" },
  { id: "gate.thresholdDb", label: "Gate Threshold", group: "Audio Effects", device: "Gate", owner: "gate", targetKinds: ["track", "master"], min: -80, max: 0, defaultValue: -40, scale: "linear", unit: "db" },
  { id: "gate.ratio", label: "Gate Ratio", group: "Audio Effects", device: "Gate", owner: "gate", targetKinds: ["track", "master"], min: 1, max: 20, defaultValue: 4, scale: "linear" },
  { id: "gate.attackMs", label: "Gate Attack", group: "Audio Effects", device: "Gate", owner: "gate", targetKinds: ["track", "master"], min: 0.1, max: 100, defaultValue: 1, scale: "linear" },
  { id: "gate.holdMs", label: "Gate Hold", group: "Audio Effects", device: "Gate", owner: "gate", targetKinds: ["track", "master"], min: 0, max: 500, defaultValue: 20, scale: "linear" },
  { id: "gate.releaseMs", label: "Gate Release", group: "Audio Effects", device: "Gate", owner: "gate", targetKinds: ["track", "master"], min: 5, max: 2e3, defaultValue: 120, scale: "linear" },
  { id: "gate.hysteresisDb", label: "Gate Hysteresis", group: "Audio Effects", device: "Gate", owner: "gate", targetKinds: ["track", "master"], min: 0, max: 24, defaultValue: 6, scale: "linear", unit: "db" },
  { id: "gate.rangeDb", label: "Gate Range", group: "Audio Effects", device: "Gate", owner: "gate", targetKinds: ["track", "master"], min: -80, max: 0, defaultValue: -80, scale: "linear", unit: "db" },
  { id: "gate.lookaheadMs", label: "Gate Lookahead", group: "Audio Effects", device: "Gate", owner: "gate", targetKinds: ["track", "master"], min: 0, max: 2, defaultValue: 0, scale: "linear" },
  { id: "gate.link", label: "Gate Link", group: "Audio Effects", device: "Gate", owner: "gate", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 1, scale: "linear" },
  { id: "limiter.ceiling", label: "Limiter Ceiling", group: "Audio Effects", device: "Limiter", owner: "limiter", targetKinds: ["track", "master"], min: -12, max: 0, defaultValue: -1, scale: "linear", unit: "db" },
  { id: "limiter.release", label: "Limiter Release", group: "Audio Effects", device: "Limiter", owner: "limiter", targetKinds: ["track", "master"], min: 20, max: 1e3, defaultValue: 100, scale: "linear" },
  { id: "limiter.link", label: "Limiter Link", group: "Audio Effects", device: "Limiter", owner: "limiter", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 1, scale: "linear" },
  { id: "lofi.bitDepth", label: "LoFi Bit Depth", group: "Audio Effects", device: "LoFi", owner: "lofi", targetKinds: ["track", "master"], min: 2, max: 24, defaultValue: 12, scale: "linear" },
  { id: "lofi.sampleRateRatio", label: "LoFi Sample Rate", group: "Audio Effects", device: "LoFi", owner: "lofi", targetKinds: ["track", "master"], min: 0.01, max: 1, defaultValue: 1, scale: "linear", unit: "percent" },
  { id: "lofi.jitter", label: "LoFi Jitter", group: "Audio Effects", device: "LoFi", owner: "lofi", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 0, scale: "linear", unit: "percent" },
  { id: "lofi.noiseDb", label: "LoFi Noise", group: "Audio Effects", device: "LoFi", owner: "lofi", targetKinds: ["track", "master"], min: -120, max: -24, defaultValue: -80, scale: "linear", unit: "db" },
  { id: "lofi.mix", label: "LoFi Mix", group: "Audio Effects", device: "LoFi", owner: "lofi", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 1, scale: "linear", unit: "percent" },
  { id: "saturator.driveDb", label: "Saturator Drive", group: "Audio Effects", device: "Saturator", owner: "saturator", targetKinds: ["track", "master"], min: dc, max: lc, defaultValue: zr().driveDb, scale: "linear", unit: "db" },
  { id: "saturator.outputDb", label: "Saturator Output", group: "Audio Effects", device: "Saturator", owner: "saturator", targetKinds: ["track", "master"], min: uc, max: pc, defaultValue: zr().outputDb, scale: "linear", unit: "db" },
  { id: "saturator.dryWet", label: "Saturator Dry/Wet", group: "Audio Effects", device: "Saturator", owner: "saturator", targetKinds: ["track", "master"], min: mc, max: fc, defaultValue: zr().dryWet, scale: "linear", unit: "percent" },
  { id: "saturator.colorFrequencyHz", label: "Saturator Color Frequency", group: "Audio Effects", device: "Saturator", owner: "saturator", targetKinds: ["track", "master"], min: hc, max: gc, defaultValue: zr().colorFrequencyHz, scale: "log", unit: "hz" },
  { id: "delay.timeMs", label: "Delay Time", group: "Audio Effects", device: "Delay", owner: "delay", targetKinds: ["track", "master"], min: bc, max: vc, defaultValue: rr().timeMs, scale: "linear" },
  { id: "delay.feedback", label: "Delay Feedback", group: "Audio Effects", device: "Delay", owner: "delay", targetKinds: ["track", "master"], min: kc, max: wc, defaultValue: rr().feedback, scale: "linear", unit: "percent" },
  { id: "delay.dryWet", label: "Delay Dry/Wet", group: "Audio Effects", device: "Delay", owner: "delay", targetKinds: ["track", "master"], min: Ic, max: Sc, defaultValue: rr().dryWet, scale: "linear", unit: "percent" },
  { id: "delay.lowCutHz", label: "Delay Low Cut", group: "Audio Effects", device: "Delay", owner: "delay", targetKinds: ["track", "master"], min: xc, max: Ec, defaultValue: rr().lowCutHz, scale: "log", unit: "hz" },
  { id: "delay.highCutHz", label: "Delay High Cut", group: "Audio Effects", device: "Delay", owner: "delay", targetKinds: ["track", "master"], min: Pc, max: Ac, defaultValue: rr().highCutHz, scale: "log", unit: "hz" },
  { id: "reverb.wet", label: "Reverb Dry/Wet", group: "Audio Effects", device: "Reverb", owner: "reverb", targetKinds: ["track", "master"], min: yg, max: bg, defaultValue: no().wet, scale: "linear", unit: "percent" },
  { id: "reverb.preDelayMs", label: "Reverb Predelay", group: "Audio Effects", device: "Reverb", owner: "reverb", targetKinds: ["track", "master"], min: vg, max: kg, defaultValue: no().preDelayMs, scale: "linear" },
  { id: "reverb.stereoWidth", label: "Reverb Width", group: "Audio Effects", device: "Reverb", owner: "reverb", targetKinds: ["track", "master"], min: wg, max: Ig, defaultValue: no().stereoWidth, scale: "linear" },
  { id: "chorus.delayMs", label: "Chorus Delay", group: "Audio Effects", device: "Chorus", owner: "chorus", targetKinds: ["track", "master"], min: 5, max: 30, defaultValue: 12, scale: "linear" },
  { id: "chorus.depthMs", label: "Chorus Depth", group: "Audio Effects", device: "Chorus", owner: "chorus", targetKinds: ["track", "master"], min: 0, max: 10, defaultValue: 4, scale: "linear" },
  { id: "chorus.rateHz", label: "Chorus Rate", group: "Audio Effects", device: "Chorus", owner: "chorus", targetKinds: ["track", "master"], min: 0.01, max: 20, defaultValue: 0.8, scale: "log", unit: "hz" },
  { id: "chorus.feedback", label: "Chorus Feedback", group: "Audio Effects", device: "Chorus", owner: "chorus", targetKinds: ["track", "master"], min: 0, max: 0.5, defaultValue: 0, scale: "linear", unit: "percent" },
  { id: "chorus.stereoPhase", label: "Chorus Stereo Phase", group: "Audio Effects", device: "Chorus", owner: "chorus", targetKinds: ["track", "master"], min: -0.5, max: 0.5, defaultValue: 0.25, scale: "linear" },
  { id: "chorus.mix", label: "Chorus Mix", group: "Audio Effects", device: "Chorus", owner: "chorus", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 0.35, scale: "linear", unit: "percent" },
  { id: "flanger.delayMs", label: "Flanger Delay", group: "Audio Effects", device: "Flanger", owner: "flanger", targetKinds: ["track", "master"], min: 0.1, max: 10, defaultValue: 1.5, scale: "linear" },
  { id: "flanger.depthMs", label: "Flanger Depth", group: "Audio Effects", device: "Flanger", owner: "flanger", targetKinds: ["track", "master"], min: 0, max: 5, defaultValue: 1, scale: "linear" },
  { id: "flanger.rateHz", label: "Flanger Rate", group: "Audio Effects", device: "Flanger", owner: "flanger", targetKinds: ["track", "master"], min: 0.01, max: 20, defaultValue: 0.2, scale: "log", unit: "hz" },
  { id: "flanger.feedback", label: "Flanger Feedback", group: "Audio Effects", device: "Flanger", owner: "flanger", targetKinds: ["track", "master"], min: -0.95, max: 0.95, defaultValue: 0.35, scale: "linear", unit: "percent" },
  { id: "flanger.stereoPhase", label: "Flanger Stereo Phase", group: "Audio Effects", device: "Flanger", owner: "flanger", targetKinds: ["track", "master"], min: -0.5, max: 0.5, defaultValue: 0.5, scale: "linear" },
  { id: "flanger.mix", label: "Flanger Mix", group: "Audio Effects", device: "Flanger", owner: "flanger", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 0.5, scale: "linear", unit: "percent" },
  { id: "phaser.centerHz", label: "Phaser Center", group: "Audio Effects", device: "Phaser", owner: "phaser", targetKinds: ["track", "master"], min: 100, max: 8e3, defaultValue: 1e3, scale: "log", unit: "hz" },
  { id: "phaser.depthOctaves", label: "Phaser Depth", group: "Audio Effects", device: "Phaser", owner: "phaser", targetKinds: ["track", "master"], min: 0, max: 5, defaultValue: 3, scale: "linear" },
  { id: "phaser.rateHz", label: "Phaser Rate", group: "Audio Effects", device: "Phaser", owner: "phaser", targetKinds: ["track", "master"], min: 0.01, max: 20, defaultValue: 0.3, scale: "log", unit: "hz" },
  { id: "phaser.feedback", label: "Phaser Feedback", group: "Audio Effects", device: "Phaser", owner: "phaser", targetKinds: ["track", "master"], min: -0.95, max: 0.95, defaultValue: 0.3, scale: "linear", unit: "percent" },
  { id: "phaser.stereoPhase", label: "Phaser Stereo Phase", group: "Audio Effects", device: "Phaser", owner: "phaser", targetKinds: ["track", "master"], min: -0.5, max: 0.5, defaultValue: 0.5, scale: "linear" },
  { id: "phaser.mix", label: "Phaser Mix", group: "Audio Effects", device: "Phaser", owner: "phaser", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 0.5, scale: "linear", unit: "percent" },
  { id: "tremolo.rateHz", label: "Tremolo Rate", group: "Audio Effects", device: "Tremolo", owner: "tremolo", targetKinds: ["track", "master"], min: 0.01, max: 20, defaultValue: 4, scale: "log", unit: "hz" },
  { id: "tremolo.depth", label: "Tremolo Depth", group: "Audio Effects", device: "Tremolo", owner: "tremolo", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 0.5, scale: "linear", unit: "percent" },
  { id: "tremolo.shape", label: "Tremolo Shape", group: "Audio Effects", device: "Tremolo", owner: "tremolo", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 0.5, scale: "linear" },
  { id: "tremolo.phase", label: "Tremolo Phase", group: "Audio Effects", device: "Tremolo", owner: "tremolo", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 0, scale: "linear" },
  { id: "autopan.rateHz", label: "Auto Pan Rate", group: "Audio Effects", device: "Auto Pan", owner: "autopan", targetKinds: ["track", "master"], min: 0.01, max: 20, defaultValue: 1, scale: "log", unit: "hz" },
  { id: "autopan.depth", label: "Auto Pan Depth", group: "Audio Effects", device: "Auto Pan", owner: "autopan", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 1, scale: "linear", unit: "percent" },
  { id: "autopan.shape", label: "Auto Pan Shape", group: "Audio Effects", device: "Auto Pan", owner: "autopan", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 0.5, scale: "linear" },
  { id: "autopan.phase", label: "Auto Pan Phase", group: "Audio Effects", device: "Auto Pan", owner: "autopan", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 0, scale: "linear" },
  { id: "ensemble.delayMs", label: "Ensemble Delay", group: "Audio Effects", device: "Ensemble", owner: "ensemble", targetKinds: ["track", "master"], min: 10, max: 30, defaultValue: 18, scale: "linear" },
  { id: "ensemble.depthMs", label: "Ensemble Depth", group: "Audio Effects", device: "Ensemble", owner: "ensemble", targetKinds: ["track", "master"], min: 1, max: 12, defaultValue: 6, scale: "linear" },
  { id: "ensemble.rateHz", label: "Ensemble Rate", group: "Audio Effects", device: "Ensemble", owner: "ensemble", targetKinds: ["track", "master"], min: 0.05, max: 5, defaultValue: 0.6, scale: "log", unit: "hz" },
  { id: "ensemble.spread", label: "Ensemble Spread", group: "Audio Effects", device: "Ensemble", owner: "ensemble", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 1, scale: "linear" },
  { id: "ensemble.mix", label: "Ensemble Mix", group: "Audio Effects", device: "Ensemble", owner: "ensemble", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 0.5, scale: "linear", unit: "percent" },
  { id: "spectral.freeze", label: "Spectral Freeze", group: "Audio Effects", device: "Spectral", owner: "spectral", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 0, scale: "linear" },
  { id: "spectral.gateThresholdDb", label: "Spectral Gate Threshold", group: "Audio Effects", device: "Spectral", owner: "spectral", targetKinds: ["track", "master"], min: -120, max: 0, defaultValue: -60, scale: "linear", unit: "db" },
  { id: "spectral.gateAttackMs", label: "Spectral Gate Attack", group: "Audio Effects", device: "Spectral", owner: "spectral", targetKinds: ["track", "master"], min: 0.1, max: 1e3, defaultValue: 10, scale: "linear" },
  { id: "spectral.gateReleaseMs", label: "Spectral Gate Release", group: "Audio Effects", device: "Spectral", owner: "spectral", targetKinds: ["track", "master"], min: 1, max: 5e3, defaultValue: 100, scale: "linear" },
  { id: "spectral.morph", label: "Spectral Morph", group: "Audio Effects", device: "Spectral", owner: "spectral", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 0, scale: "linear", unit: "percent" },
  { id: "spectral.binShift", label: "Spectral Bin Shift", group: "Audio Effects", device: "Spectral", owner: "spectral", targetKinds: ["track", "master"], min: -2048, max: 2048, defaultValue: 0, scale: "linear" },
  { id: "spectral.blur", label: "Spectral Blur", group: "Audio Effects", device: "Spectral", owner: "spectral", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 0, scale: "linear", unit: "percent" },
  { id: "spectral.harmonicPercussiveBalance", label: "Spectral HPSS Balance", group: "Audio Effects", device: "Spectral", owner: "spectral", targetKinds: ["track", "master"], min: -1, max: 1, defaultValue: 0, scale: "linear" },
  { id: "spectral.noiseReduction", label: "Spectral Noise Reduction", group: "Audio Effects", device: "Spectral", owner: "spectral", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 0, scale: "linear", unit: "percent" },
  { id: "spectral.profileLearn", label: "Spectral Profile Learn", group: "Audio Effects", device: "Spectral", owner: "spectral", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 0, scale: "linear", unit: "percent" },
  { id: "spectral.mix", label: "Spectral Mix", group: "Audio Effects", device: "Spectral", owner: "spectral", targetKinds: ["track", "master"], min: 0, max: 1, defaultValue: 1, scale: "linear", unit: "percent" }
];
_e.filter((e) => e.owner === "utility"), _e.filter((e) => e.owner === "autofilter"), _e.filter((e) => e.owner === "gate"), _e.filter((e) => e.owner === "limiter"), _e.filter((e) => e.owner === "lofi"), _e.filter((e) => e.owner === "saturator"), _e.filter((e) => e.owner === "delay"), _e.filter((e) => e.owner === "reverb"), _e.filter((e) => e.owner === "chorus"), _e.filter((e) => e.owner === "flanger"), _e.filter((e) => e.owner === "phaser"), _e.filter((e) => e.owner === "tremolo"), _e.filter((e) => e.owner === "autopan"), _e.filter((e) => e.owner === "ensemble"), _e.filter((e) => e.owner === "spectral");
const Ay = (e) => {
  const t = e.split(".");
  if (t.length !== 3 || t[0] !== "eq" || !t[1]) return null;
  const r = t[2];
  return r !== "frequencyHz" && r !== "gainDb" && r !== "q" ? null : { bandId: t[1], property: r };
}, id = (e) => {
  const t = Py.find((d) => d.id === e);
  if (t) return t;
  const r = _e.find((d) => d.id === e);
  if (r) return r;
  const n = ly(e);
  if (n) {
    const d = Jc[n.parameterId];
    return {
      id: e,
      label: n.parameterId,
      group: "Instrument",
      device: "Sampler",
      owner: "sampler",
      targetKinds: ["track"],
      min: d.min,
      max: d.max,
      defaultValue: d.defaultValue,
      scale: d.unit === "hz" ? "log" : "linear",
      unit: d.unit === "ratio" ? "percent" : d.unit
    };
  }
  const o = hy(e);
  if (o) {
    const d = ed[o.parameterId];
    return {
      id: e,
      label: o.parameterId,
      group: "Instrument",
      device: "Granular",
      owner: "granular",
      targetKinds: ["track"],
      min: d.min,
      max: d.max,
      defaultValue: d.defaultValue,
      scale: d.unit === "hz" ? "log" : "linear",
      unit: d.unit === "ratio" ? "percent" : d.unit
    };
  }
  const a = Sy(e);
  if (a) {
    const d = ad[a.parameterId];
    return {
      id: e,
      label: a.parameterId,
      group: "Instrument",
      device: "Synth",
      owner: "synth",
      targetKinds: ["track"],
      min: d.min,
      max: d.max,
      defaultValue: d.defaultValue,
      scale: d.unit === "hz" || d.unit === "seconds" ? "log" : "linear",
      unit: d.unit === "ratio" ? "percent" : d.unit
    };
  }
  const i = Ay(e), s = Ey(e);
  if (!i && s)
    return {
      id: e,
      label: `VST3 Parameter ${s.parameterId}`,
      group: "VST3",
      device: "VST3",
      owner: "external",
      targetKinds: ["track", "master"],
      min: 0,
      max: 1,
      defaultValue: 0,
      scale: "linear"
    };
  if (i)
    return i.property === "frequencyHz" ? { id: e, label: "EQ Frequency", group: "Audio Effects", device: "EQ Eight", owner: "eq", targetKinds: ["track", "master"], min: 20, max: 2e4, defaultValue: 1e3, scale: "log", unit: "hz" } : i.property === "gainDb" ? { id: e, label: "EQ Gain", group: "Audio Effects", device: "EQ Eight", owner: "eq", targetKinds: ["track", "master"], min: -24, max: 24, defaultValue: 0, scale: "linear", unit: "db" } : { id: e, label: "EQ Q", group: "Audio Effects", device: "EQ Eight", owner: "eq", targetKinds: ["track", "master"], min: 0.1, max: 18, defaultValue: 1, scale: "linear" };
}, Jo = (e, t) => id(e)?.targetKinds.includes(t) ?? !1, _y = (e, t) => {
  const r = /* @__PURE__ */ new Map();
  for (const n of e) {
    if (!Number.isFinite(n.timeSec) || !Number.isFinite(n.value) || !n.id) continue;
    const o = Math.max(0, n.timeSec);
    r.set(o, {
      id: n.id,
      timeSec: o,
      value: xy(n.value, t.min, t.max),
      interpolation: tg(n.interpolation) ? n.interpolation : "linear"
    });
  }
  return [...r.values()].sort((n, o) => n.timeSec - o.timeSec || n.id.localeCompare(o.id));
}, zy = 30, Ty = 300, Ry = -16, Cy = 16, fn = 1e3, sd = (e) => typeof e == "object" && e !== null && !Array.isArray(e), My = (e) => typeof e == "number" && Number.isFinite(e) ? Math.round(Math.min(Ty, Math.max(zy, e)) * 100) / 100 : void 0, Dy = (e) => Math.round(
  Math.min(Cy, Math.max(Ry, e)) * fn
) / fn, Vy = (e) => {
  if (typeof e != "number" || !Number.isFinite(e)) return;
  const t = Dy(e);
  return Object.is(t, -0) || t === 0 ? void 0 : t;
}, Ri = (e) => typeof e == "number" && Number.isFinite(e) ? Math.round(e * fn) / fn : void 0;
function Oy(e) {
  if (!Array.isArray(e)) return;
  const t = e.flatMap((o) => {
    if (!sd(o) || typeof o.id != "string" || o.id.length === 0) return [];
    const a = Ri(o.sourceBeat), i = Ri(o.timelineBeat);
    return a === void 0 || i === void 0 ? [] : [{ id: o.id, sourceBeat: a, timelineBeat: i }];
  }).sort((o, a) => o.timelineBeat - a.timelineBeat), r = [], n = /* @__PURE__ */ new Set();
  for (const o of t) {
    const a = r[r.length - 1];
    n.has(o.id) || a && (o.timelineBeat <= a.timelineBeat || o.sourceBeat <= a.sourceBeat) || (n.add(o.id), r.push(o));
  }
  return r.length > 0 ? r : void 0;
}
const By = (e) => Math.min(2, Math.max(0, e));
function Fy(e) {
  if (sd(e))
    return {
      enabled: "enabled" in e ? !!e.enabled : !1,
      sourceBpm: My(e.sourceBpm),
      sourceBeatOffset: Vy(e.sourceBeatOffset),
      markers: Oy(e.markers),
      mode: e.mode === "stretch" ? "stretch" : "repitch"
    };
}
function cd(e) {
  if (!(typeof e != "number" || !Number.isFinite(e) || e <= 0))
    return e;
}
function Ci(e) {
  const t = cd(e);
  if (t !== void 0)
    return Math.max(1, Math.round(t));
}
function Ny(e) {
  if (typeof e != "string") return;
  const t = e.trim();
  return t.length > 0 ? t : void 0;
}
function $y(e) {
  if (e === "upload" || e === "url" || e === "recording") return e;
}
function qy(e) {
  return {
    assetKey: Ny(e.assetKey),
    sourceKind: $y(e.sourceKind),
    durationSec: cd(e.durationSec),
    sampleRate: Ci(e.sampleRate),
    channelCount: Ci(e.channelCount)
  };
}
const Hy = (e) => e === "clip-audio" || e === "clip-midi" || e === "clip-recording", Ly = (e) => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(e), Uy = (e) => e.length === 4 ? `#${e[1]}${e[1]}${e[2]}${e[2]}${e[3]}${e[3]}` : e, pt = (e) => e && Ly(e) ? Uy(e).toLowerCase() : void 0, Xo = (e) => e && (Hy(e) ? e : pt(e));
function Mi(e) {
  return Number.isFinite(e) ? Math.max(0, e) : 0;
}
function oo(e) {
  if (!(typeof e != "number" || !Number.isFinite(e)))
    return Math.max(0, e);
}
function Zy(e) {
  return {
    startSec: Mi(e.startSec),
    duration: Mi(e.duration),
    leftPadSec: oo(e.leftPadSec),
    bufferOffsetSec: oo(e.bufferOffsetSec),
    midiOffsetBeats: oo(e.midiOffsetBeats)
  };
}
const jy = 16, Ky = 36;
function an(e, t, r) {
  return Math.max(t, Math.min(r, e));
}
function gt(e) {
  return typeof e == "number" && Number.isFinite(e) ? e : void 0;
}
function Wy(e) {
  const t = qy({
    assetKey: e?.assetKey,
    sourceKind: typeof e?.sourceKind == "string" ? e.sourceKind : void 0,
    durationSec: gt(e?.source?.durationSec),
    sampleRate: gt(e?.source?.sampleRate),
    channelCount: gt(e?.source?.channelCount)
  });
  if (!(t.assetKey === void 0 || typeof e?.url != "string" || !e.url || t.sourceKind === void 0 || t.durationSec === void 0 || t.sampleRate === void 0 || t.channelCount === void 0))
    return {
      assetKey: t.assetKey,
      url: e.url,
      name: typeof e.name == "string" && e.name ? e.name : void 0,
      sourceKind: t.sourceKind,
      source: {
        durationSec: t.durationSec,
        sampleRate: t.sampleRate,
        channelCount: t.channelCount
      }
    };
}
function Gy(e) {
  const t = Ky + e;
  return {
    id: `pad-${t}`,
    note: t,
    gain: 1,
    pan: 0,
    transpose: 0,
    startSec: 0,
    mute: !1,
    chokeGroup: 0
  };
}
function Qy() {
  const e = Array.from({ length: jy }, (t, r) => Gy(r));
  return {
    pads: e,
    selectedPadId: e[0]?.id
  };
}
function Jy(e) {
  const t = Qy(), r = e.pads ?? [], n = t.pads.map((a, i) => {
    const s = r[i], d = Wy(s?.sample), m = Math.max(0, gt(s?.startSec) ?? a.startSec), h = gt(s?.endSec), g = h !== void 0 && h > m ? h : void 0;
    return {
      ...a,
      name: typeof s?.name == "string" && s.name ? s.name : void 0,
      sample: d,
      gain: an(gt(s?.gain) ?? a.gain, 0, 2),
      pan: an(gt(s?.pan) ?? a.pan, -1, 1),
      transpose: Math.round(an(gt(s?.transpose) ?? a.transpose, -48, 48)),
      startSec: m,
      endSec: g,
      mute: typeof s?.mute == "boolean" ? s.mute : a.mute,
      chokeGroup: Math.round(an(gt(s?.chokeGroup) ?? a.chokeGroup, 0, 16))
    };
  }), o = typeof e.selectedPadId == "string" && n.some((a) => a.id === e.selectedPadId) ? e.selectedPadId : n[0]?.id;
  return { pads: n, selectedPadId: o };
}
function Xy(e) {
  return e === "synth" || e === "drum-rack" || e === "sampler" || e === "granular";
}
const sn = (e) => typeof e == "object" && e !== null && !Array.isArray(e);
function Yy(e) {
  if (!sn(e) || !Xy(e.kind)) return;
  const t = typeof e.instanceId == "string" && e.instanceId ? e.instanceId : void 0;
  if (t)
    return e.kind === "synth" ? { kind: e.kind, instanceId: t, params: od(e.params) } : e.kind === "sampler" ? { kind: e.kind, instanceId: t, params: cy(sn(e.params) ? e.params : {}) } : e.kind === "granular" ? { kind: e.kind, instanceId: t, params: my(sn(e.params) ? e.params : {}) } : {
      kind: e.kind,
      instanceId: t,
      params: Jy(sn(e.params) ? e.params : {})
    };
}
const eb = 1;
function tb(e) {
  return Number.isFinite(e) ? Math.min(1, Math.max(0, Math.round(e * 100) / 100)) : eb;
}
const Ve = k().finite(), zt = R().min(1).max(256), ct = k().int().min(1).max(16), On = Ve.min(0).max(1), Yo = k().int().min(0).max(127), rb = P(["sine", "square", "sawtooth", "triangle"]), nb = R(), Di = 500, Vi = 500, Oi = 64, dd = c({
  id: zt.optional(),
  beat: Ve,
  length: Ve.positive(),
  pitch: Yo,
  velocity: On.optional(),
  channel: ct.optional()
}).strict(), ob = dd.extend({
  length: Ve,
  pitch: Ve,
  velocity: Ve.optional()
}).strict(), ab = c({
  id: zt.optional(),
  beat: Ve,
  controller: k().int().min(0).max(127),
  value: On,
  channel: ct.optional()
}).strict(), ib = c({
  id: zt.optional(),
  beat: Ve,
  value: Ve.min(-1).max(1),
  channel: ct.optional()
}).strict(), sb = c({
  id: zt.optional(),
  beat: Ve,
  value: On,
  channel: ct.optional()
}).strict(), cb = c({
  id: zt.optional(),
  beat: Ve,
  pitch: Yo,
  value: On,
  channel: ct.optional()
}).strict(), db = J("kind", [
  c({ kind: l("cc"), controller: k().int().min(0).max(127), channel: ct.optional() }).strict(),
  c({ kind: l("pitch-bend"), channel: ct.optional() }).strict(),
  c({ kind: l("channel-pressure"), channel: ct.optional() }).strict(),
  c({ kind: l("poly-pressure"), channel: ct.optional(), pitch: Yo.optional() }).strict()
]), lb = c({
  id: zt,
  source: db,
  target: c({
    parameterId: zt,
    effectInstanceId: zt.optional()
  }).strict(),
  outputMin: Ve,
  outputMax: Ve
}).strict(), ld = c({
  wave: rb,
  gain: Ve.min(0).max(2).optional(),
  inputChannel: ct.optional(),
  notes: T(dd),
  cc: T(ab).optional(),
  pitchBends: T(ib).optional(),
  channelPressure: T(sb).optional(),
  polyPressure: T(cb).optional(),
  mappings: T(lb).optional()
}).strict(), ub = ld.extend({
  wave: nb,
  gain: Ve.optional(),
  notes: T(ob)
}).strict(), pb = (e) => [
  e.notes,
  e.cc ?? [],
  e.pitchBends ?? [],
  e.channelPressure ?? [],
  e.polyPressure ?? []
], Bi = (e) => {
  const t = /* @__PURE__ */ new Set(), r = /* @__PURE__ */ new Set();
  for (const n of e)
    n !== void 0 && (t.has(n) && r.add(n), t.add(n));
  return [...r];
}, ea = ub, st = ld.superRefine((e, t) => {
  const r = pb(e);
  r.some((n) => n.length > Vi) && t.addIssue({ code: "custom", message: `MIDI event arrays support at most ${Vi} events.` }), r.reduce((n, o) => n + o.length, 0) > Di && t.addIssue({ code: "custom", message: `MIDI clips support at most ${Di} performance events.` }), (e.mappings?.length ?? 0) > Oi && t.addIssue({ code: "custom", message: `MIDI clips support at most ${Oi} mappings.` }), Bi(r.flatMap((n) => n.map((o) => o.id))).length > 0 && t.addIssue({ code: "custom", message: "MIDI event IDs must be unique." }), Bi((e.mappings ?? []).map((n) => n.id)).length > 0 && t.addIssue({ code: "custom", message: "MIDI mapping IDs must be unique." });
}), ta = (e, t) => e < t ? -1 : e > t ? 1 : 0, ud = (e) => JSON.stringify(
  Object.entries(e).filter(([t]) => t !== "id").sort(([t], [r]) => ta(t, r))
), mb = (e, t, r) => `midi:${e}:${ud(t)}:${r}`, wr = (e, t, r, n) => {
  const o = /* @__PURE__ */ new Map(), a = (t ?? []).map((s) => {
    const d = { ...s, channel: s.channel ?? 1 };
    if (s.id !== void 0) return d;
    const m = ud(d), h = o.get(m) ?? 0;
    o.set(m, h + 1);
    const g = mb(e, d, h);
    let S = g, _ = 1;
    for (; n.has(S); )
      S = `${g}:${_}`, _ += 1;
    return n.add(S), { ...d, id: S };
  }), i = /* @__PURE__ */ new Set();
  for (const s of a) {
    if (s.id === void 0) throw new Error("MIDI event IDs must be normalized.");
    if (i.has(s.id)) throw new Error(`Duplicate MIDI ${e} ID: ${s.id}`);
    i.add(s.id);
  }
  return a.sort((s, d) => r(s, d) || ta(s.id ?? "", d.id ?? ""));
}, Ir = (e, t) => e.beat - t.beat, pd = (e, t) => {
  const r = t(e), n = new Set(
    [r.notes, r.cc ?? [], r.pitchBends ?? [], r.channelPressure ?? [], r.polyPressure ?? []].flatMap((g) => g.flatMap((S) => S.id === void 0 ? [] : [S.id]))
  ), o = wr("note", r.notes, (g, S) => Ir(g, S) || g.pitch - S.pitch || g.length - S.length || (g.velocity ?? 0) - (S.velocity ?? 0), n), a = wr("cc", r.cc, (g, S) => Ir(g, S) || g.controller - S.controller || g.value - S.value, n), i = wr("pitch-bend", r.pitchBends, (g, S) => Ir(g, S) || g.value - S.value, n), s = wr("channel-pressure", r.channelPressure, (g, S) => Ir(g, S) || g.value - S.value, n), d = wr("poly-pressure", r.polyPressure, (g, S) => Ir(g, S) || g.pitch - S.pitch || g.value - S.value, n), m = [...r.mappings ?? []].sort((g, S) => ta(g.id, S.id)), h = /* @__PURE__ */ new Set();
  for (const g of [...o, ...a, ...i, ...s, ...d]) {
    if (g.id === void 0) throw new Error("MIDI event IDs must be normalized.");
    if (h.has(g.id)) throw new Error(`Duplicate MIDI event ID: ${g.id}`);
    h.add(g.id);
  }
  return {
    wave: r.wave,
    ...r.gain === void 0 ? {} : { gain: r.gain },
    ...r.inputChannel === void 0 ? {} : { inputChannel: r.inputChannel },
    notes: o,
    cc: a,
    pitchBends: i,
    channelPressure: s,
    polyPressure: d,
    mappings: m
  };
}, ra = (e) => {
  const t = st.parse(e), r = pd(t, (n) => st.parse(n));
  return {
    wave: t.wave,
    ...t.gain === void 0 ? {} : { gain: t.gain },
    ...t.inputChannel === void 0 ? {} : { inputChannel: t.inputChannel },
    notes: r.notes,
    cc: r.cc,
    pitchBends: r.pitchBends,
    channelPressure: r.channelPressure,
    polyPressure: r.polyPressure,
    mappings: r.mappings
  };
}, fb = (e) => pd(e, (t) => ea.parse(t)), hb = (e) => e.notes.length + (e.cc?.length ?? 0) + (e.pitchBends?.length ?? 0) + (e.channelPressure?.length ?? 0) + (e.polyPressure?.length ?? 0), b = k().finite(), dt = R().min(1), mt = (e) => c({
  version: l(1),
  state: e
}).strict(), gb = c({
  id: dt,
  frequency: b,
  gainDb: b,
  q: b,
  enabled: M(),
  type: P(["lowpass", "highpass", "bandpass", "lowshelf", "highshelf", "peaking", "notch", "allpass"])
}).strict(), md = c({ bands: T(gb), enabled: M(), channelMode: P(["stereo", "mono"]) }).strict(), fd = c({
  enabled: M(),
  wet: b,
  decaySec: b,
  preDelayMs: b,
  reflections: b,
  reflectionSpin: M(),
  reflectionModAmountMs: b,
  reflectionModRateHz: b,
  reflectionShape: b,
  diffuse: b,
  size: b,
  diffusion: b,
  density: b,
  lowCutHz: b,
  highCutHz: b,
  diffusionLowCutHz: b,
  diffusionHighCutHz: b,
  stereoWidth: b
}).strict(), hd = c({
  enabled: M(),
  driveDb: b,
  curve: P(["soft", "medium", "hard", "clip"]),
  color: M(),
  colorFrequencyHz: b,
  colorAmount: b,
  outputDb: b,
  dryWet: b
}).strict(), gd = c({
  enabled: M(),
  mode: P(["sync", "time"]),
  timeMs: b,
  syncDivision: P(["1/16", "1/8", "1/4", "1/2", "1/1"]),
  feedback: b,
  dryWet: b,
  pingPong: M(),
  filterEnabled: M(),
  lowCutHz: b,
  highCutHz: b
}).strict(), yd = c({
  enabled: M(),
  thresholdDb: b,
  ratio: b,
  attackMs: b,
  releaseMs: b,
  autoRelease: M(),
  makeupDb: b,
  outputDb: b,
  dryWet: b,
  kneeDb: b,
  lookaheadMs: b,
  detectorMode: P(["peak", "rms"]),
  dynamicsMode: P(["compress", "expand"]),
  envelopeCurve: P(["log", "linear"]),
  sidechain: c({
    enabled: M(),
    filterType: P(["lowpass", "highpass", "bandpass"]),
    frequencyHz: b,
    q: b
  }).strict()
}).strict(), bd = mt(c({
  enabled: M(),
  gainDb: b,
  polarity: P(["normal", "invert"]),
  inputMode: P(["stereo", "mono-sum"]),
  pan: b,
  balance: b,
  width: b,
  matrix: P(["stereo", "mid-side-encode", "mid-side-decode"]),
  swap: M(),
  dcBlock: M()
}).strict()), vd = mt(c({
  enabled: M(),
  mode: P(["gate", "expander"]),
  thresholdDb: b,
  ratio: b,
  attackMs: b,
  holdMs: b,
  releaseMs: b,
  hysteresisDb: b,
  rangeDb: b,
  lookaheadMs: b,
  detector: P(["peak", "rms"]),
  link: b,
  sidechain: c({
    enabled: M(),
    filterType: l("highpass"),
    frequencyHz: b,
    q: b
  }).strict()
}).strict()), kd = mt(c({
  enabled: M(),
  ceilingDbtp: b,
  releaseMs: b,
  lookaheadMs: b,
  link: b,
  detectorOversampling: l(4)
}).strict()), wd = mt(c({
  enabled: M(),
  mode: P(["lowpass", "highpass", "bandpass", "notch", "peak"]),
  frequencyHz: b,
  resonance: b,
  driveDb: b,
  mix: b,
  envelope: c({ amountOctaves: b, attackMs: b, releaseMs: b }).strict(),
  lfo: c({
    waveform: P(["sine", "triangle"]),
    rateHz: b,
    depthOctaves: b,
    phaseOffset: b,
    stereoPhase: b
  }).strict(),
  quality: l("2x")
}).strict()), hn = mt(c({
  enabled: M(),
  delayMs: b,
  depthMs: b,
  rateHz: b,
  feedback: b,
  stereoPhase: b,
  mix: b
}).strict()), Id = mt(c({
  enabled: M(),
  stages: ce([l(4), l(6), l(8), l(12)]),
  centerHz: b,
  depthOctaves: b,
  rateHz: b,
  feedback: b,
  stereoPhase: b,
  mix: b
}).strict()), gn = mt(c({
  enabled: M(),
  waveform: P(["sine", "triangle"]),
  rateHz: b,
  depth: b,
  shape: b,
  phase: b
}).strict()), Sd = mt(c({
  enabled: M(),
  voices: l(3),
  delayMs: b,
  depthMs: b,
  rateHz: b,
  spread: b,
  mix: b
}).strict()), xd = mt(c({
  enabled: M(),
  bitDepth: b,
  sampleRateRatio: b,
  jitter: b,
  noiseDb: b,
  quantization: P(["round", "floor", "truncate"]),
  dither: P(["off", "rectangular", "triangular"]),
  mix: b,
  seed: b
}).strict()), Ed = mt(c({
  enabled: M(),
  fftSize: ce([l(512), l(1024), l(2048), l(4096)]),
  overlap: ce([l(2), l(4)]),
  mode: P(["freeze", "gate", "morph", "shift-blur", "hpss", "noise-reduce"]),
  freeze: b,
  gateThresholdDb: b,
  gateAttackMs: b,
  gateReleaseMs: b,
  morph: b,
  binShift: b,
  blur: b,
  harmonicPercussiveBalance: b,
  noiseReduction: b,
  profileLearn: b,
  mix: b
}).strict()), Fi = c({
  attackSec: b,
  decaySec: b,
  sustain: b,
  releaseSec: b
}).strict(), xo = c({
  version: l(2),
  oscillators: tc([
    c({ enabled: M(), wave: P(["sine", "square", "sawtooth", "triangle"]), octave: b, semitone: b, detuneCents: b, level: b }).strict(),
    c({ enabled: M(), wave: P(["sine", "square", "sawtooth", "triangle"]), octave: b, semitone: b, detuneCents: b, level: b }).strict()
  ]),
  ampEnvelope: Fi,
  filter: c({
    enabled: M(),
    mode: P(["lowpass", "highpass", "bandpass", "notch"]),
    frequencyHz: b,
    q: b,
    keyTracking: b,
    envelopeAmountOctaves: b,
    envelope: Fi
  }).strict(),
  lfo: c({
    enabled: M(),
    wave: P(["sine", "square", "sawtooth", "triangle"]),
    frequencyHz: b,
    pitchCents: b,
    filterOctaves: b,
    amp: b,
    pan: b
  }).strict(),
  noise: c({ enabled: M(), level: b }).strict(),
  gain: b,
  pan: b,
  polyphony: b,
  retrigger: M()
}).strict(), yb = c({
  wave1: P(["sine", "square", "sawtooth", "triangle"]),
  wave2: P(["sine", "square", "sawtooth", "triangle"]),
  gain: b.optional(),
  attackMs: b.optional(),
  releaseMs: b.optional()
}).strict(), Pd = c({
  assetKey: dt,
  url: dt,
  name: R().optional(),
  sourceKind: P(["upload", "url", "recording"]),
  source: c({ durationSec: b, sampleRate: b, channelCount: b }).strict()
}).strict(), Ad = c({
  id: dt,
  sample: Pd,
  keyLow: b,
  keyHigh: b,
  velocityLow: b,
  velocityHigh: b,
  rootNote: b,
  tuneCents: b,
  gain: b,
  pan: b,
  roundRobinGroup: b,
  roundRobinIndex: b,
  playbackMode: P(["one-shot", "forward-loop", "crossfade-loop"]),
  startSec: b,
  endSec: b.optional(),
  loopStartSec: b.optional(),
  loopEndSec: b.optional(),
  crossfadeSec: b,
  chokeGroup: b
}).strict(), Ni = c({
  attackSec: b,
  decaySec: b,
  sustain: b,
  releaseSec: b,
  amount: b
}).strict(), Eo = c({
  version: l(1),
  zones: T(Ad),
  ampEnvelope: Ni,
  filterEnvelope: Ni,
  filterMode: P(["lowpass", "highpass", "bandpass", "notch"]),
  filterFrequencyHz: b,
  filterQ: b,
  lfo: c({
    enabled: M(),
    frequencyHz: b,
    pitchCents: b,
    filterHz: b,
    amp: b,
    pan: b
  }).strict(),
  polyphony: b,
  retrigger: M(),
  cachePolicy: P(["preload", "lazy"]),
  maxDecodedBytes: b
}).strict(), Po = c({
  version: l(1),
  zone: Ad.optional(),
  grainSizeMs: b,
  densityHz: b,
  position: b,
  spray: b,
  pitchSemitones: b,
  reverseProbability: b,
  windowShape: P(["hann", "tukey", "gaussian"]),
  stereoSpread: b,
  freeze: M(),
  seed: b,
  maxGrains: b,
  maxDecodedBytes: b
}).strict(), Ao = c({
  pads: T(c({
    id: dt,
    note: b,
    name: R().optional(),
    sample: Pd.optional(),
    gain: b,
    pan: b,
    transpose: b,
    startSec: b,
    endSec: b.optional(),
    mute: M(),
    chokeGroup: b
  }).strict()),
  selectedPadId: dt.optional()
}).strict(), _d = c({
  enabled: M(),
  pattern: P(["up", "down", "updown", "random"]),
  rate: P(["1/4", "1/8", "1/16", "1/32"]),
  octaves: b,
  gate: b,
  hold: M()
}).strict(), bb = J("effectKind", [
  c({ effectKind: l("utility"), params: bd.optional() }).strict(),
  c({ effectKind: l("eq"), params: md.optional() }).strict(),
  c({ effectKind: l("autofilter"), params: wd.optional() }).strict(),
  c({ effectKind: l("gate"), params: vd.optional() }).strict(),
  c({ effectKind: l("compressor"), params: yd.optional() }).strict(),
  c({ effectKind: l("saturator"), params: hd.optional() }).strict(),
  c({ effectKind: l("limiter"), params: kd.optional() }).strict(),
  c({ effectKind: l("lofi"), params: xd.optional() }).strict(),
  c({ effectKind: l("chorus"), params: hn.optional() }).strict(),
  c({ effectKind: l("flanger"), params: hn.optional() }).strict(),
  c({ effectKind: l("phaser"), params: Id.optional() }).strict(),
  c({ effectKind: l("tremolo"), params: gn.optional() }).strict(),
  c({ effectKind: l("autopan"), params: gn.optional() }).strict(),
  c({ effectKind: l("ensemble"), params: Sd.optional() }).strict(),
  c({ effectKind: l("delay"), params: gd.optional() }).strict(),
  c({ effectKind: l("reverb"), params: fd.optional() }).strict(),
  c({ effectKind: l("spectral"), params: Ed.optional() }).strict()
]), vb = J("instrumentKind", [
  c({ instrumentKind: l("synth"), params: xo.optional() }).strict(),
  c({ instrumentKind: l("drum-rack"), params: Ao.optional() }).strict(),
  c({ instrumentKind: l("sampler"), params: Eo.optional() }).strict(),
  c({ instrumentKind: l("granular"), params: Po.optional() }).strict()
]), zd = J("kind", [
  c({ kind: l("utility"), params: bd }).strict(),
  c({ kind: l("eq"), params: md }).strict(),
  c({ kind: l("autofilter"), params: wd }).strict(),
  c({ kind: l("gate"), params: vd }).strict(),
  c({ kind: l("compressor"), params: yd }).strict(),
  c({ kind: l("saturator"), params: hd }).strict(),
  c({ kind: l("limiter"), params: kd }).strict(),
  c({ kind: l("lofi"), params: xd }).strict(),
  c({ kind: l("chorus"), params: hn }).strict(),
  c({ kind: l("flanger"), params: hn }).strict(),
  c({ kind: l("phaser"), params: Id }).strict(),
  c({ kind: l("tremolo"), params: gn }).strict(),
  c({ kind: l("autopan"), params: gn }).strict(),
  c({ kind: l("ensemble"), params: Sd }).strict(),
  c({ kind: l("delay"), params: gd }).strict(),
  c({ kind: l("reverb"), params: fd }).strict(),
  c({ kind: l("spectral"), params: Ed }).strict(),
  c({ kind: l("synth"), params: ce([xo, yb]) }).strict(),
  c({ kind: l("drum-rack"), params: Ao }).strict(),
  c({ kind: l("sampler"), params: Eo }).strict(),
  c({ kind: l("granular"), params: Po }).strict(),
  c({ kind: l("instrument"), params: J("kind", [
    c({ kind: l("synth"), instanceId: dt, params: xo }).strict(),
    c({ kind: l("drum-rack"), instanceId: dt, params: Ao }).strict(),
    c({ kind: l("sampler"), instanceId: dt, params: Eo }).strict(),
    c({ kind: l("granular"), instanceId: dt, params: Po }).strict()
  ]) }).strict(),
  c({ kind: l("arpeggiator"), params: _d }).strict()
]), ee = () => ({ trackIds: /* @__PURE__ */ new Set(), clipIds: /* @__PURE__ */ new Set() }), Bn = (e) => ({ trackIds: /* @__PURE__ */ new Set([e]), clipIds: /* @__PURE__ */ new Set() }), Td = (e) => ({ trackIds: /* @__PURE__ */ new Set(), clipIds: new Set(e) }), It = (e) => N(e) && typeof e.clipId == "string" ? Td([e.clipId]) : ee(), kb = (e) => {
  if (!N(e) || !Array.isArray(e.updates)) return ee();
  const t = /* @__PURE__ */ new Set();
  for (const r of e.updates)
    N(r) && (typeof r.trackId == "string" && t.add(r.trackId), typeof r.groupId == "string" && t.add(r.groupId), typeof r.outputTargetId == "string" && t.add(r.outputTargetId));
  return { trackIds: t, clipIds: /* @__PURE__ */ new Set() };
}, N = (e) => typeof e == "object" && e !== null && !Array.isArray(e), se = (e) => typeof e == "number" ? e : void 0, wb = (e) => typeof e == "boolean" ? e : void 0, me = (e) => typeof e == "string" ? e : void 0, Ib = (e) => typeof e == "string" || e === null ? e : void 0, na = (e) => Fy(e), oa = (e) => {
  if (N(e) && !(typeof e.fadeInSec != "number" || typeof e.fadeOutSec != "number" || typeof e.fadeInCurve != "number" || typeof e.fadeOutCurve != "number"))
    return {
      fadeInStartSec: typeof e.fadeInStartSec == "number" ? e.fadeInStartSec : 0,
      fadeInSec: e.fadeInSec,
      fadeOutSec: e.fadeOutSec,
      fadeOutEndSec: typeof e.fadeOutEndSec == "number" ? e.fadeOutEndSec : 0,
      fadeInCurve: e.fadeInCurve,
      fadeOutCurve: e.fadeOutCurve,
      fadeInCurvePosition: typeof e.fadeInCurvePosition == "number" ? e.fadeInCurvePosition : 0.5,
      fadeOutCurvePosition: typeof e.fadeOutCurvePosition == "number" ? e.fadeOutCurvePosition : 0.5
    };
}, Rd = (e) => Array.isArray(e) ? e.flatMap((t) => typeof t == "string" ? [t] : []) : [], Cd = (e) => {
  if (!Array.isArray(e)) return null;
  const t = [], r = /* @__PURE__ */ new Set();
  for (const n of e) {
    if (!mr(n) && !iy(n)) return null;
    const o = typeof n == "string" ? n : n.id;
    r.has(o) || (r.add(o), t.push(n));
  }
  return t;
}, Bt = (e) => typeof e == "string" && e.length > 0 ? e : null, Cr = (e, t) => !N(t) || t.version !== 1 || !N(t.state) ? null : e === "utility" ? Ae.utility.normalizeParams({ version: 1, state: t.state }) : e === "gate" ? Ae.gate.normalizeParams({ version: 1, state: t.state }) : Ae.limiter.normalizeParams({ version: 1, state: t.state }), Md = (e, t) => !N(t) || t.version !== 1 || !N(t.state) ? null : e === "autofilter" ? { effect: e, params: Ae.autofilter.normalizeParams(t) } : e === "chorus" ? { effect: e, params: Ae.chorus.normalizeParams(t) } : e === "flanger" ? { effect: e, params: Ae.flanger.normalizeParams(t) } : e === "phaser" ? { effect: e, params: Ae.phaser.normalizeParams(t) } : e === "tremolo" ? { effect: e, params: Ae.tremolo.normalizeParams(t) } : e === "autopan" ? { effect: e, params: Ae.autopan.normalizeParams(t) } : e === "ensemble" ? { effect: e, params: Ae.ensemble.normalizeParams(t) } : e === "lofi" ? { effect: e, params: Ae.lofi.normalizeParams(t) } : null, ft = (e, t) => {
  const r = Bt(t.instanceId);
  return r ? { params: e, instanceId: r } : null;
}, Dd = (e) => Array.isArray(e) ? e.flatMap((t) => N(t) && typeof t.clipId == "string" && typeof t.trackId == "string" && typeof t.startSec == "number" ? [{ clipId: t.clipId, trackId: t.trackId, startSec: t.startSec }] : []) : [], Vd = (e) => Array.isArray(e) ? e.flatMap((t) => N(t) && typeof t.targetId == "string" && typeof t.amount == "number" ? [{
  targetId: t.targetId,
  amount: t.amount,
  ...t.tap === "pre-fx" || t.tap === "pre-fader" || t.tap === "post-fader" ? { tap: t.tap } : {}
}] : []) : void 0, Od = (e, t) => {
  if (!N(e) || typeof e.trackId != "string" || typeof e.startSec != "number" || typeof e.duration != "number" || e.midi !== void 0 && !N(e.midi)) return null;
  let r;
  try {
    r = e.midi === void 0 ? void 0 : t?.durable ? fb(e.midi) : ra(e.midi);
  } catch {
    return null;
  }
  return !(!!r || e.clipKind === "midi") && (typeof e.sampleUrl != "string" || typeof e.assetKey != "string" || typeof e.sourceKind != "string" || typeof e.durationSec != "number" || typeof e.sampleRate != "number" || typeof e.channelCount != "number") ? null : {
    trackId: e.trackId,
    startSec: e.startSec,
    duration: e.duration,
    name: me(e.name),
    sampleUrl: me(e.sampleUrl),
    assetKey: me(e.assetKey),
    sourceKind: me(e.sourceKind),
    durationSec: se(e.durationSec),
    sampleRate: se(e.sampleRate),
    channelCount: se(e.channelCount),
    leftPadSec: se(e.leftPadSec),
    bufferOffsetSec: se(e.bufferOffsetSec),
    audioWarp: na(e.audioWarp),
    gain: se(e.gain),
    fades: oa(e.fades),
    midiOffsetBeats: se(e.midiOffsetBeats),
    color: Xo(me(e.color)),
    midi: r,
    clipKind: me(e.clipKind),
    operationId: me(e.operationId)
  };
}, aa = (e) => {
  if (!N(e) || typeof e.enabled != "boolean" || !Array.isArray(e.bands)) return null;
  const t = e.bands.flatMap((r) => !N(r) || typeof r.id != "string" || typeof r.frequency != "number" || typeof r.gainDb != "number" || typeof r.q != "number" || typeof r.enabled != "boolean" ? [] : cc(r.type) ? [{ id: r.id, type: r.type, frequency: r.frequency, gainDb: r.gainDb, q: r.q, enabled: r.enabled }] : []);
  return t.length === e.bands.length ? gg({ enabled: e.enabled, channelMode: e.channelMode, bands: t }) : null;
}, ia = (e) => {
  if (!N(e) || typeof e.enabled != "boolean") return null;
  const t = {
    enabled: e.enabled,
    wet: se(e.wet),
    decaySec: se(e.decaySec),
    preDelayMs: se(e.preDelayMs),
    reflections: se(e.reflections),
    reflectionSpin: typeof e.reflectionSpin == "boolean" ? e.reflectionSpin : void 0,
    reflectionModAmountMs: se(e.reflectionModAmountMs),
    reflectionModRateHz: se(e.reflectionModRateHz),
    reflectionShape: se(e.reflectionShape),
    diffuse: se(e.diffuse),
    size: se(e.size),
    diffusion: se(e.diffusion),
    density: se(e.density),
    lowCutHz: se(e.lowCutHz),
    highCutHz: se(e.highCutHz),
    diffusionLowCutHz: se(e.diffusionLowCutHz),
    diffusionHighCutHz: se(e.diffusionHighCutHz),
    stereoWidth: se(e.stereoWidth)
  };
  return t.wet === void 0 || t.decaySec === void 0 || t.preDelayMs === void 0 ? null : {
    ...t,
    enabled: e.enabled,
    wet: t.wet,
    decaySec: t.decaySec,
    preDelayMs: t.preDelayMs
  };
}, sa = (e) => {
  if (!N(e) || typeof e.enabled != "boolean" || typeof e.thresholdDb != "number" || typeof e.ratio != "number" || typeof e.attackMs != "number" || typeof e.releaseMs != "number" || typeof e.autoRelease != "boolean" || typeof e.makeupDb != "number" || typeof e.outputDb != "number" || typeof e.dryWet != "number" || typeof e.kneeDb != "number" || typeof e.lookaheadMs != "number" || !Tc(e.detectorMode) || !Rc(e.dynamicsMode) || !Cc(e.envelopeCurve) || !N(e.sidechain) || typeof e.sidechain.enabled != "boolean" || !Mc(e.sidechain.filterType) || typeof e.sidechain.frequencyHz != "number" || typeof e.sidechain.q != "number") return null;
  const t = {
    enabled: e.enabled,
    thresholdDb: e.thresholdDb,
    ratio: e.ratio,
    attackMs: e.attackMs,
    releaseMs: e.releaseMs,
    autoRelease: e.autoRelease,
    makeupDb: e.makeupDb,
    outputDb: e.outputDb,
    dryWet: e.dryWet,
    kneeDb: e.kneeDb,
    lookaheadMs: e.lookaheadMs,
    detectorMode: e.detectorMode,
    dynamicsMode: e.dynamicsMode,
    envelopeCurve: e.envelopeCurve,
    sidechain: {
      enabled: e.sidechain.enabled,
      filterType: e.sidechain.filterType,
      frequencyHz: e.sidechain.frequencyHz,
      q: e.sidechain.q
    }
  };
  return Wg(t);
}, ca = (e) => {
  if (!N(e) || typeof e.enabled != "boolean" || typeof e.driveDb != "number" || !yc(e.curve) || typeof e.color != "boolean" || typeof e.colorFrequencyHz != "number" || typeof e.colorAmount != "number" || typeof e.outputDb != "number" || typeof e.dryWet != "number") return null;
  const t = {
    enabled: e.enabled,
    driveDb: e.driveDb,
    curve: e.curve,
    color: e.color,
    colorFrequencyHz: e.colorFrequencyHz,
    colorAmount: e.colorAmount,
    outputDb: e.outputDb,
    dryWet: e.dryWet
  };
  return Eg(t);
}, da = (e) => {
  if (!N(e) || typeof e.enabled != "boolean" || !_c(e.mode) || typeof e.timeMs != "number" || !zc(e.syncDivision) || typeof e.feedback != "number" || typeof e.dryWet != "number" || typeof e.pingPong != "boolean" || typeof e.filterEnabled != "boolean" || typeof e.lowCutHz != "number" || typeof e.highCutHz != "number") return null;
  const t = {
    enabled: e.enabled,
    mode: e.mode,
    timeMs: e.timeMs,
    syncDivision: e.syncDivision,
    feedback: e.feedback,
    dryWet: e.dryWet,
    pingPong: e.pingPong,
    filterEnabled: e.filterEnabled,
    lowCutHz: e.lowCutHz,
    highCutHz: e.highCutHz
  };
  return Pg(t);
}, la = (e) => ky(e) ?? null, Sb = (e) => e === "up" || e === "down" || e === "updown" || e === "random" ? e : null, xb = (e) => e === "1/4" || e === "1/8" || e === "1/16" || e === "1/32" ? e : null, ua = (e) => {
  if (!N(e)) return null;
  const t = Sb(e.pattern), r = xb(e.rate);
  return !t || !r || typeof e.enabled != "boolean" || typeof e.octaves != "number" || typeof e.gate != "number" || typeof e.hold != "boolean" ? null : { enabled: e.enabled, pattern: t, rate: r, octaves: e.octaves, gate: e.gate, hold: e.hold };
}, ie = (e) => N(e) && typeof e.trackId == "string" ? Bn(e.trackId) : ee(), Eb = (e) => {
  if (!N(e) || typeof e.trackId != "string" || !N(e.routing)) return ee();
  const t = Bn(e.trackId);
  typeof e.routing.outputTargetId == "string" && t.trackIds.add(e.routing.outputTargetId);
  for (const r of Vd(e.routing.sends) ?? []) t.trackIds.add(r.targetId);
  return t;
}, Pb = (e) => {
  if (!N(e) || typeof e.trackId != "string") return ee();
  const t = Bn(e.trackId);
  return typeof e.groupId == "string" && t.trackIds.add(e.groupId), t;
}, Ab = (e) => {
  const t = pt(me(e.color));
  return e.color !== void 0 && !t ? null : {
    kind: "tracks.create",
    payload: {
      name: me(e.name),
      index: se(e.index),
      kind: me(e.kind),
      channelRole: me(e.channelRole),
      collapsed: wb(e.collapsed),
      color: t,
      operationId: me(e.operationId)
    }
  };
}, _b = (e) => typeof e.trackId == "string" ? { kind: "tracks.lock", payload: { trackId: e.trackId } } : null, zb = (e) => typeof e.trackId == "string" ? { kind: "tracks.unlock", payload: { trackId: e.trackId } } : null, Tb = (e) => {
  const t = Od(e);
  return t ? { kind: "clips.create", payload: t } : null;
}, Rb = (e) => {
  if (!Array.isArray(e.items)) return null;
  const t = e.items.flatMap((r) => {
    const n = Od(r);
    return n ? [n] : [];
  });
  return t.length === e.items.length ? { kind: "clips.createMany", payload: { items: t, operationId: me(e.operationId) } } : null;
}, Cb = (e) => {
  const t = Rd(e.clipIds), r = me(e.operationId);
  return t.length > 0 && r ? { kind: "clips.removeMany", payload: { clipIds: t, operationId: r } } : null;
}, Mb = (e) => {
  const t = Dd(e.moves);
  return t.length > 0 ? { kind: "clips.moveMany", payload: { moves: t } } : null;
}, Bd = (e) => typeof e.clipId != "string" || typeof e.startSec != "number" || typeof e.duration != "number" ? null : {
  clipId: e.clipId,
  ...Zy({
    startSec: e.startSec,
    duration: e.duration,
    leftPadSec: se(e.leftPadSec),
    bufferOffsetSec: se(e.bufferOffsetSec),
    midiOffsetBeats: se(e.midiOffsetBeats)
  }),
  fades: oa(e.fades)
}, Db = (e) => {
  const t = Bd(e);
  return t ? { kind: "clips.setTiming", payload: t } : null;
}, Vb = (e) => {
  const t = Bd(e);
  if (!t) return null;
  const r = na(e.audioWarp);
  return {
    kind: "clips.setTimingAndAudioWarp",
    payload: r ? { ...t, audioWarp: r } : t
  };
}, Ob = (e) => {
  const t = na(e.audioWarp);
  return typeof e.clipId == "string" && t ? { kind: "clips.setAudioWarp", payload: { clipId: e.clipId, audioWarp: t } } : null;
}, Bb = (e) => typeof e.clipId == "string" && typeof e.gain == "number" ? { kind: "clips.setGain", payload: { clipId: e.clipId, gain: By(e.gain) } } : null, Fb = (e) => {
  const t = oa(e.fades);
  return typeof e.clipId == "string" && t ? { kind: "clips.setFades", payload: { clipId: e.clipId, fades: t } } : null;
}, Nb = (e) => {
  const t = Xo(me(e.color));
  return typeof e.clipId == "string" && t ? { kind: "clips.setColor", payload: { clipId: e.clipId, color: t } } : null;
}, $b = (e) => {
  if (typeof e.clipId != "string" || typeof e.operationId != "string" || e.operationId.length === 0 || !N(e.midi) || Object.keys(e).some((r) => r !== "clipId" && r !== "midi" && r !== "operationId")) return null;
  let t;
  try {
    t = ra(e.midi);
  } catch {
    return null;
  }
  return {
    kind: "clips.setMidi",
    payload: {
      clipId: e.clipId,
      operationId: e.operationId,
      midi: t
    }
  };
}, qb = (e) => {
  if (typeof e.clipId != "string" || typeof e.startSec != "number" || typeof e.duration != "number" || typeof e.operationId != "string" || e.operationId.length === 0 || !N(e.midi) || Object.keys(e).some((t) => !["clipId", "startSec", "duration", "midi", "operationId"].includes(t))) return null;
  try {
    return {
      kind: "clips.setMidiAndTiming",
      payload: {
        clipId: e.clipId,
        startSec: e.startSec,
        duration: e.duration,
        midi: ra(e.midi),
        operationId: e.operationId
      }
    };
  } catch {
    return null;
  }
}, Hb = (e) => typeof e.trackId != "string" || !N(e.routing) ? null : {
  kind: "tracks.setRouting",
  payload: {
    trackId: e.trackId,
    routing: {
      outputTargetId: me(e.routing.outputTargetId),
      sends: Vd(e.routing.sends)
    }
  }
}, Lb = (e) => typeof e.projectId == "string" && typeof e.sourceTrackId == "string" && typeof e.targetTrackId == "string" && typeof e.effectInstanceId == "string" && e.effectInstanceId.length > 0 ? {
  kind: "sidechains.setRoute",
  payload: {
    projectId: e.projectId,
    sourceTrackId: e.sourceTrackId,
    targetTrackId: e.targetTrackId,
    effectInstanceId: e.effectInstanceId
  }
} : null, Ub = (e) => typeof e.projectId == "string" && typeof e.targetTrackId == "string" && typeof e.effectInstanceId == "string" && e.effectInstanceId.length > 0 ? { kind: "sidechains.removeRoute", payload: { projectId: e.projectId, targetTrackId: e.targetTrackId, effectInstanceId: e.effectInstanceId } } : null, Zb = (e) => typeof e.trackId == "string" ? { kind: "tracks.setGroup", payload: { trackId: e.trackId, groupId: Ib(e.groupId) } } : null, jb = (e) => {
  if (!Array.isArray(e.updates)) return null;
  const t = e.updates.flatMap((r) => !N(r) || typeof r.trackId != "string" || typeof r.index != "number" ? [] : [{
    trackId: r.trackId,
    index: r.index,
    groupId: typeof r.groupId == "string" || r.groupId === null ? r.groupId : void 0,
    outputTargetId: typeof r.outputTargetId == "string" || r.outputTargetId === null ? r.outputTargetId : void 0
  }]);
  return t.length === e.updates.length ? { kind: "tracks.reorderAndGroup", payload: { updates: t } } : null;
}, Kb = (e) => mr(e) || e === "instrument" || e === "synth" || e === "arpeggiator", Fd = (e, t) => {
  const r = id(e);
  if (!r || !Array.isArray(t)) return null;
  const n = [];
  for (const o of t)
    N(o) && typeof o.id == "string" && typeof o.timeSec == "number" && typeof o.value == "number" && n.push({
      id: o.id,
      timeSec: o.timeSec,
      value: o.value,
      interpolation: o.interpolation === "hold" ? "hold" : "linear"
    });
  return _y(n, r);
}, Nd = (e) => {
  if (!Array.isArray(e)) return null;
  const t = [], r = /* @__PURE__ */ new Set();
  for (const n of e) {
    if (!N(n) || !Kb(n.type) || !("params" in n) || n.instanceId !== void 0 && (typeof n.instanceId != "string" || n.instanceId.length === 0) || n.index !== void 0 && (typeof n.index != "number" || !Number.isInteger(n.index) || n.index < 0)) return null;
    const o = typeof n.instanceId == "string" ? n.instanceId : void 0, a = typeof n.index == "number" ? n.index : void 0;
    if (!mr(n.type) && (o !== void 0 || a !== void 0)) return null;
    const i = (() => {
      switch (n.type) {
        case "utility":
          return Cr("utility", n.params);
        case "eq":
          return aa(n.params);
        case "autofilter":
        case "lofi":
        case "chorus":
        case "flanger":
        case "phaser":
        case "tremolo":
        case "autopan":
        case "ensemble":
          return Md(n.type, n.params)?.params ?? null;
        case "gate":
          return Cr("gate", n.params);
        case "limiter":
          return Cr("limiter", n.params);
        case "compressor":
          return sa(n.params);
        case "saturator":
          return ca(n.params);
        case "delay":
          return da(n.params);
        case "reverb":
          return ia(n.params);
        case "spectral":
          return pa(n.params);
        case "instrument":
          return ma(n.params);
        case "synth":
          return la(n.params);
        case "arpeggiator":
          return ua(n.params);
      }
    })();
    if (!i) return null;
    const s = `${n.type}:${o ?? ""}`;
    if (r.has(s)) return null;
    r.add(s), t.push({
      type: n.type,
      instanceId: o,
      index: a,
      params: i
    });
  }
  return t;
}, Wb = (e) => {
  if (!Array.isArray(e)) return null;
  const t = [], r = /* @__PURE__ */ new Set();
  for (const n of e) {
    if (!N(n) || typeof n.parameterId != "string" || typeof n.enabled != "boolean" || typeof n.updatedAt != "number" || !Array.isArray(n.points) || !Jo(n.parameterId, "track") || n.effectInstanceId !== void 0 && (typeof n.effectInstanceId != "string" || n.effectInstanceId.length === 0)) return null;
    const o = Fd(n.parameterId, n.points);
    if (!o) return null;
    const a = typeof n.effectInstanceId == "string" ? n.effectInstanceId : void 0, i = eg({ kind: "track", trackId: "restore-group", effectInstanceId: a }, n.parameterId);
    if (r.has(i)) return null;
    r.add(i), t.push({ effectInstanceId: a, parameterId: n.parameterId, enabled: n.enabled, points: o, updatedAt: n.updatedAt });
  }
  return t;
}, Gb = (e) => typeof e.groupId == "string" ? { kind: "tracks.ungroup", payload: { groupId: e.groupId, operationId: me(e.operationId) } } : null, Qb = (e) => {
  if (!N(e.group) || !Array.isArray(e.children)) return null;
  const t = e.group;
  if (typeof t.index != "number" || typeof t.volume != "number" || !Array.isArray(t.sends) || t.kind !== void 0 && typeof t.kind != "string" || t.name !== void 0 && typeof t.name != "string" || t.historyRef !== void 0 && typeof t.historyRef != "string" || t.parentGroupId !== void 0 && typeof t.parentGroupId != "string" || t.collapsed !== void 0 && typeof t.collapsed != "boolean" || t.color !== void 0 && (typeof t.color != "string" || !pt(t.color)) || t.muted !== void 0 && typeof t.muted != "boolean" || t.soloed !== void 0 && typeof t.soloed != "boolean" || t.outputTargetId !== void 0 && typeof t.outputTargetId != "string") return null;
  const r = t.sends.flatMap((d) => N(d) && typeof d.targetId == "string" && typeof d.amount == "number" && (d.tap === void 0 || d.tap === "pre-fx" || d.tap === "pre-fader" || d.tap === "post-fader") ? [{ targetId: d.targetId, amount: d.amount, tap: d.tap }] : []);
  if (r.length !== t.sends.length) return null;
  const n = e.children.flatMap((d) => N(d) && typeof d.trackId == "string" && typeof d.outputToGroup == "boolean" && (d.outputTargetId === void 0 || typeof d.outputTargetId == "string") ? [{ trackId: d.trackId, outputTargetId: typeof d.outputTargetId == "string" ? d.outputTargetId : void 0, outputToGroup: d.outputToGroup }] : []);
  if (n.length !== e.children.length) return null;
  const o = Nd(e.effects), a = Wb(e.automation);
  if (!o || !a || e.sidechainRoutes !== void 0 && !Array.isArray(e.sidechainRoutes)) return null;
  const i = Array.isArray(e.sidechainRoutes) ? e.sidechainRoutes : [], s = i.flatMap((d) => N(d) && (d.sourceTrackId === void 0 || typeof d.sourceTrackId == "string") && (d.targetTrackId === void 0 || typeof d.targetTrackId == "string") && typeof d.effectInstanceId == "string" && d.sourceTrackId !== d.targetTrackId ? [{
    sourceTrackId: typeof d.sourceTrackId == "string" ? d.sourceTrackId : void 0,
    targetTrackId: typeof d.targetTrackId == "string" ? d.targetTrackId : void 0,
    effectInstanceId: d.effectInstanceId
  }] : []);
  return s.length !== i.length ? null : {
    kind: "tracks.restoreUngroup",
    payload: {
      group: {
        name: typeof t.name == "string" ? t.name : void 0,
        index: t.index,
        kind: typeof t.kind == "string" ? t.kind : void 0,
        historyRef: typeof t.historyRef == "string" ? t.historyRef : void 0,
        parentGroupId: typeof t.parentGroupId == "string" ? t.parentGroupId : void 0,
        collapsed: typeof t.collapsed == "boolean" ? t.collapsed : void 0,
        color: typeof t.color == "string" ? pt(t.color) : void 0,
        volume: t.volume,
        muted: typeof t.muted == "boolean" ? t.muted : void 0,
        soloed: typeof t.soloed == "boolean" ? t.soloed : void 0,
        outputTargetId: typeof t.outputTargetId == "string" ? t.outputTargetId : void 0,
        sends: r
      },
      children: n,
      effects: o,
      automation: a,
      ...e.sidechainRoutes === void 0 ? {} : { sidechainRoutes: s },
      operationId: me(e.operationId)
    }
  };
}, Jb = (e) => typeof e.trackId == "string" && typeof e.collapsed == "boolean" ? { kind: "tracks.setCollapsed", payload: { trackId: e.trackId, collapsed: e.collapsed } } : null, Xb = (e) => typeof e.trackId == "string" && (e.color === void 0 || pt(me(e.color))) ? { kind: "tracks.setColor", payload: { trackId: e.trackId, color: pt(me(e.color)) } } : null, Yb = (e) => typeof e.rootTrackId == "string" && typeof e.cascadeClipColors == "boolean" && (e.color === null || e.color === void 0 || pt(me(e.color))) ? {
  kind: "tracks.setColorCascade",
  payload: {
    rootTrackId: e.rootTrackId,
    color: e.color === null ? null : pt(me(e.color)),
    cascadeClipColors: e.cascadeClipColors
  }
} : null, ev = (e) => {
  if (!Array.isArray(e.trackUpdates) || !Array.isArray(e.clipUpdates)) return null;
  const t = e.trackUpdates.flatMap((n) => N(n) && typeof n.trackId == "string" && (n.color === null || n.color === void 0 || pt(me(n.color))) ? [{ trackId: n.trackId, color: n.color === null ? null : pt(me(n.color)) }] : []), r = e.clipUpdates.flatMap((n) => N(n) && typeof n.clipId == "string" && typeof n.color == "string" && Xo(n.color) ? [{ clipId: n.clipId, color: n.color }] : []);
  return t.length === e.trackUpdates.length && r.length === e.clipUpdates.length ? { kind: "tracks.applyColorBatch", payload: { trackUpdates: t, clipUpdates: r } } : null;
}, tv = (e) => typeof e.trackId == "string" && typeof e.volume == "number" ? { kind: "tracks.setVolume", payload: { trackId: e.trackId, volume: e.volume } } : null, rv = (e) => typeof e.trackId == "string" ? {
  kind: "tracks.setMix",
  payload: {
    trackId: e.trackId,
    muted: typeof e.muted == "boolean" ? e.muted : void 0,
    soloed: typeof e.soloed == "boolean" ? e.soloed : void 0
  }
} : null, nv = (e) => typeof e.volume == "number" ? { kind: "mixer.setMasterVolume", payload: { volume: tb(e.volume) } } : null, ov = (e) => {
  const t = aa(e.params), r = t ? ft(t, e) : null;
  return typeof e.trackId == "string" && r ? { kind: "effects.setEqParams", payload: { trackId: e.trackId, ...r } } : null;
}, ao = (e, t, r) => {
  const n = Cr(e, r.params), o = Bt(r.instanceId);
  return typeof r.trackId != "string" || !n || !o ? null : t === "effects.setUtilityParams" ? { kind: t, payload: { trackId: r.trackId, instanceId: o, params: Ae.utility.normalizeParams(n) } } : t === "effects.setGateParams" ? { kind: t, payload: { trackId: r.trackId, instanceId: o, params: Ae.gate.normalizeParams(n) } } : { kind: t, payload: { trackId: r.trackId, instanceId: o, params: Ae.limiter.normalizeParams(n) } };
}, $i = (e, t) => {
  const r = Bt(e.instanceId), n = Md(e.effect, e.params);
  return !r || !n ? null : t === "track" ? typeof e.trackId != "string" ? null : n.effect === "autofilter" ? { kind: "effects.setModulationParams", payload: { ...n, instanceId: r, trackId: e.trackId } } : n.effect === "chorus" ? { kind: "effects.setModulationParams", payload: { ...n, instanceId: r, trackId: e.trackId } } : n.effect === "flanger" ? { kind: "effects.setModulationParams", payload: { ...n, instanceId: r, trackId: e.trackId } } : n.effect === "phaser" ? { kind: "effects.setModulationParams", payload: { ...n, instanceId: r, trackId: e.trackId } } : n.effect === "tremolo" ? { kind: "effects.setModulationParams", payload: { ...n, instanceId: r, trackId: e.trackId } } : n.effect === "autopan" ? { kind: "effects.setModulationParams", payload: { ...n, instanceId: r, trackId: e.trackId } } : { kind: "effects.setModulationParams", payload: { ...n, instanceId: r, trackId: e.trackId } } : n.effect === "autofilter" ? { kind: "effects.setMasterModulationParams", payload: { ...n, instanceId: r } } : n.effect === "chorus" ? { kind: "effects.setMasterModulationParams", payload: { ...n, instanceId: r } } : n.effect === "flanger" ? { kind: "effects.setMasterModulationParams", payload: { ...n, instanceId: r } } : n.effect === "phaser" ? { kind: "effects.setMasterModulationParams", payload: { ...n, instanceId: r } } : n.effect === "tremolo" ? { kind: "effects.setMasterModulationParams", payload: { ...n, instanceId: r } } : n.effect === "autopan" ? { kind: "effects.setMasterModulationParams", payload: { ...n, instanceId: r } } : { kind: "effects.setMasterModulationParams", payload: { ...n, instanceId: r } };
}, av = (e) => {
  const t = ia(e.params), r = t ? ft(t, e) : null;
  return typeof e.trackId == "string" && r ? { kind: "effects.setReverbParams", payload: { trackId: e.trackId, ...r } } : null;
}, iv = (e) => {
  const t = sa(e.params), r = t ? ft(t, e) : null;
  return typeof e.trackId == "string" && r ? { kind: "effects.setCompressorParams", payload: { trackId: e.trackId, ...r } } : null;
}, sv = (e) => {
  const t = ca(e.params), r = t ? ft(t, e) : null;
  return typeof e.trackId == "string" && r ? { kind: "effects.setSaturatorParams", payload: { trackId: e.trackId, ...r } } : null;
}, cv = (e) => {
  const t = da(e.params), r = t ? ft(t, e) : null;
  return typeof e.trackId == "string" && r ? { kind: "effects.setDelayParams", payload: { trackId: e.trackId, ...r } } : null;
}, pa = (e) => {
  if (!N(e)) return null;
  const t = ig(e);
  return e.version === 1 && N(e.state) ? t : null;
}, dv = (e) => {
  const t = pa(e.params), r = Bt(e.instanceId);
  return typeof e.trackId == "string" && t && r ? { kind: "effects.setSpectralParams", payload: { trackId: e.trackId, params: t, instanceId: r } } : null;
}, lv = (e) => {
  const t = Cd(e.order);
  return typeof e.trackId == "string" && t ? { kind: "effects.reorderAudioChain", payload: { trackId: e.trackId, order: t } } : null;
}, uv = (e) => {
  if (typeof e.trackId != "string" || typeof e.operationId != "string" || e.operationId.length === 0 || !Array.isArray(e.audioEffects)) return null;
  const t = Nd(e.audioEffects.map((a) => N(a) ? { type: a.kind, instanceId: a.id, params: a.params } : a));
  if (!t || t.length !== e.audioEffects.length) return null;
  const r = t.flatMap((a) => mr(a.type) && a.instanceId ? [{ id: a.instanceId, kind: a.type, params: a.params }] : []);
  if (r.length !== t.length) return null;
  const n = e.instrument === void 0 ? void 0 : ma(e.instrument), o = e.arpeggiator === void 0 ? void 0 : ua(e.arpeggiator);
  return e.instrument !== void 0 && !n || e.arpeggiator !== void 0 && !o ? null : {
    kind: "effects.restoreChain",
    payload: {
      trackId: e.trackId,
      audioEffects: r,
      ...n ? { instrument: n } : {},
      ...o ? { arpeggiator: o } : {},
      operationId: e.operationId
    }
  };
}, pv = (e) => {
  if (!mr(e.effect)) return null;
  const t = Bt(e.instanceId);
  return t ? e.targetType === "master" ? { kind: "effects.removeAudioEffect", payload: { targetType: "master", effect: e.effect, instanceId: t } } : e.targetType === "track" && typeof e.trackId == "string" ? { kind: "effects.removeAudioEffect", payload: { targetType: "track", trackId: e.trackId, effect: e.effect, instanceId: t } } : null : null;
}, mv = (e) => {
  const t = la(e.params), r = Bt(e.instanceId);
  return typeof e.trackId == "string" && t && r ? { kind: "effects.setSynthParams", payload: { trackId: e.trackId, params: t, instanceId: r } } : null;
}, ma = (e) => {
  if (N(e) && e.kind === "synth" && typeof e.instanceId == "string" && e.instanceId) {
    const t = la(e.params);
    return t ? { kind: "synth", instanceId: e.instanceId, params: t } : null;
  }
  return Yy(e) ?? null;
}, fv = (e) => {
  const t = ma(e.instrument);
  return typeof e.trackId == "string" && t ? { kind: "instruments.setTrackInstrument", payload: { trackId: e.trackId, instrument: t } } : null;
}, qi = (e, t) => typeof t.trackId == "string" && typeof t.operationId == "string" && t.operationId.length > 0 && Object.keys(t).every((r) => r === "trackId" || r === "operationId") ? { kind: e, payload: { trackId: t.trackId, operationId: t.operationId } } : null, hv = (e) => {
  const t = ua(e.params);
  return typeof e.trackId == "string" && t ? { kind: "effects.setArpeggiatorParams", payload: { trackId: e.trackId, params: t } } : null;
}, gv = (e) => {
  const t = aa(e.params), r = t ? ft(t, e) : null;
  return r ? { kind: "effects.setMasterEqParams", payload: r } : null;
}, io = (e, t, r) => {
  const n = Cr(e, r.params), o = Bt(r.instanceId);
  return !n || !o ? null : t === "effects.setMasterUtilityParams" ? { kind: t, payload: { instanceId: o, params: Ae.utility.normalizeParams(n) } } : t === "effects.setMasterGateParams" ? { kind: t, payload: { instanceId: o, params: Ae.gate.normalizeParams(n) } } : { kind: t, payload: { instanceId: o, params: Ae.limiter.normalizeParams(n) } };
}, yv = (e) => {
  const t = ia(e.params), r = t ? ft(t, e) : null;
  return r ? { kind: "effects.setMasterReverbParams", payload: r } : null;
}, bv = (e) => {
  const t = sa(e.params), r = t ? ft(t, e) : null;
  return r ? { kind: "effects.setMasterCompressorParams", payload: r } : null;
}, vv = (e) => {
  const t = ca(e.params), r = t ? ft(t, e) : null;
  return r ? { kind: "effects.setMasterSaturatorParams", payload: r } : null;
}, kv = (e) => {
  const t = da(e.params), r = t ? ft(t, e) : null;
  return r ? { kind: "effects.setMasterDelayParams", payload: r } : null;
}, wv = (e) => {
  const t = pa(e.params), r = Bt(e.instanceId);
  return t && r ? { kind: "effects.setMasterSpectralParams", payload: { params: t, instanceId: r } } : null;
}, Iv = (e) => {
  const t = Cd(e.order);
  return t ? { kind: "effects.reorderMasterAudioChain", payload: { order: t } } : null;
}, $d = (e) => e === "track" || e === "master" ? e : null, Sv = (e) => {
  const t = $d(e.targetKind);
  if (!t || typeof e.parameterId != "string" || typeof e.enabled != "boolean" || typeof e.updatedAt != "number" || t === "track" && typeof e.trackId != "string") return null;
  const r = t === "track" && typeof e.trackId == "string" ? e.trackId : void 0, n = typeof e.effectInstanceId == "string" ? e.effectInstanceId : void 0;
  if (!Jo(e.parameterId, t)) return null;
  const o = Fd(e.parameterId, e.points);
  return o ? {
    kind: "automation.setEnvelope",
    payload: {
      targetKind: t,
      trackId: r,
      effectInstanceId: n,
      parameterId: e.parameterId,
      enabled: e.enabled,
      points: o,
      updatedAt: e.updatedAt
    }
  } : null;
}, xv = (e) => {
  const t = $d(e.targetKind);
  if (!t || typeof e.parameterId != "string" || t === "track" && typeof e.trackId != "string") return null;
  const r = t === "track" && typeof e.trackId == "string" ? e.trackId : void 0, n = typeof e.effectInstanceId == "string" ? e.effectInstanceId : void 0;
  return Jo(e.parameterId, t) ? {
    kind: "automation.deleteEnvelope",
    payload: {
      targetKind: t,
      trackId: r,
      effectInstanceId: n,
      parameterId: e.parameterId
    }
  } : null;
}, qd = [
  { kind: "tracks.create", parse: Ab, targets: ee, durableQueue: !0 },
  { kind: "tracks.lock", parse: _b, targets: ie, durableQueue: !1 },
  { kind: "tracks.unlock", parse: zb, targets: ie, durableQueue: !1 },
  { kind: "clips.create", parse: Tb, targets: ie, durableQueue: !0 },
  {
    kind: "clips.createMany",
    parse: Rb,
    targets: (e) => {
      if (!N(e) || !Array.isArray(e.items)) return ee();
      const t = ee();
      for (const r of e.items)
        N(r) && typeof r.trackId == "string" && t.trackIds.add(r.trackId);
      return t;
    },
    durableQueue: !0
  },
  {
    kind: "clips.removeMany",
    parse: Cb,
    targets: (e) => N(e) ? Td(Rd(e.clipIds)) : ee(),
    durableQueue: !0
  },
  {
    kind: "clips.moveMany",
    parse: Mb,
    targets: (e) => {
      if (!N(e)) return ee();
      const t = ee();
      for (const r of Dd(e.moves))
        t.trackIds.add(r.trackId), t.clipIds.add(r.clipId);
      return t;
    },
    durableQueue: !0
  },
  {
    kind: "clips.setTiming",
    parse: Db,
    targets: It,
    durableQueue: !0
  },
  {
    kind: "clips.setTimingAndAudioWarp",
    parse: Vb,
    targets: It,
    durableQueue: !0
  },
  {
    kind: "clips.setAudioWarp",
    parse: Ob,
    targets: It,
    durableQueue: !0
  },
  {
    kind: "clips.setGain",
    parse: Bb,
    targets: It,
    durableQueue: !0
  },
  {
    kind: "clips.setFades",
    parse: Fb,
    targets: It,
    durableQueue: !0
  },
  { kind: "clips.setColor", parse: Nb, targets: It, durableQueue: !0 },
  { kind: "clips.setMidi", parse: $b, targets: It, durableQueue: !0 },
  { kind: "clips.setMidiAndTiming", parse: qb, targets: It, durableQueue: !0 },
  { kind: "tracks.setRouting", parse: Hb, targets: Eb, durableQueue: !0 },
  {
    kind: "sidechains.setRoute",
    parse: Lb,
    targets: (e) => {
      if (!N(e)) return ee();
      const t = /* @__PURE__ */ new Set();
      return typeof e.sourceTrackId == "string" && t.add(e.sourceTrackId), typeof e.targetTrackId == "string" && t.add(e.targetTrackId), { trackIds: t, clipIds: /* @__PURE__ */ new Set() };
    },
    durableQueue: !0
  },
  {
    kind: "sidechains.removeRoute",
    parse: Ub,
    targets: (e) => !N(e) || typeof e.targetTrackId != "string" ? ee() : { trackIds: /* @__PURE__ */ new Set([e.targetTrackId]), clipIds: /* @__PURE__ */ new Set() },
    durableQueue: !0
  },
  { kind: "tracks.setGroup", parse: Zb, targets: Pb, durableQueue: !0 },
  { kind: "tracks.reorderAndGroup", parse: jb, targets: kb, durableQueue: !0 },
  { kind: "tracks.ungroup", parse: Gb, targets: ee, durableQueue: !0 },
  { kind: "tracks.restoreUngroup", parse: Qb, targets: (e) => {
    if (!N(e) || !N(e.group) || !Array.isArray(e.children)) return ee();
    const t = ee(), r = e.group;
    if (typeof r.parentGroupId == "string" && t.trackIds.add(r.parentGroupId), typeof r.outputTargetId == "string" && t.trackIds.add(r.outputTargetId), Array.isArray(r.sends))
      for (const n of r.sends) N(n) && typeof n.targetId == "string" && t.trackIds.add(n.targetId);
    for (const n of e.children)
      N(n) && (typeof n.trackId == "string" && t.trackIds.add(n.trackId), typeof n.outputTargetId == "string" && t.trackIds.add(n.outputTargetId));
    if (Array.isArray(e.sidechainRoutes)) for (const n of e.sidechainRoutes)
      N(n) && (typeof n.sourceTrackId == "string" && t.trackIds.add(n.sourceTrackId), typeof n.targetTrackId == "string" && t.trackIds.add(n.targetTrackId));
    return t;
  }, durableQueue: !0 },
  { kind: "tracks.setCollapsed", parse: Jb, targets: ie, durableQueue: !0 },
  { kind: "tracks.setColor", parse: Xb, targets: ie, durableQueue: !0 },
  { kind: "tracks.setColorCascade", parse: Yb, targets: (e) => N(e) && typeof e.rootTrackId == "string" ? Bn(e.rootTrackId) : ee(), durableQueue: !0 },
  { kind: "tracks.applyColorBatch", parse: ev, targets: (e) => {
    if (!N(e) || !Array.isArray(e.trackUpdates) || !Array.isArray(e.clipUpdates)) return ee();
    const t = ee();
    for (const r of e.trackUpdates) N(r) && typeof r.trackId == "string" && t.trackIds.add(r.trackId);
    for (const r of e.clipUpdates) N(r) && typeof r.clipId == "string" && t.clipIds.add(r.clipId);
    return t;
  }, durableQueue: !0 },
  { kind: "tracks.setVolume", parse: tv, targets: ie, durableQueue: !0 },
  { kind: "tracks.setMix", parse: rv, targets: ie, durableQueue: !0 },
  { kind: "mixer.setMasterVolume", parse: nv, targets: ee, durableQueue: !0 },
  { kind: "effects.setEqParams", parse: ov, targets: ie, durableQueue: !0 },
  { kind: "effects.setUtilityParams", parse: (e) => ao("utility", "effects.setUtilityParams", e), targets: ie, durableQueue: !0 },
  { kind: "effects.setLimiterParams", parse: (e) => ao("limiter", "effects.setLimiterParams", e), targets: ie, durableQueue: !0 },
  { kind: "effects.setModulationParams", parse: (e) => $i(e, "track"), targets: ie, durableQueue: !0 },
  { kind: "effects.setGateParams", parse: (e) => ao("gate", "effects.setGateParams", e), targets: ie, durableQueue: !0 },
  { kind: "effects.setCompressorParams", parse: iv, targets: ie, durableQueue: !0 },
  { kind: "effects.setSaturatorParams", parse: sv, targets: ie, durableQueue: !0 },
  { kind: "effects.setDelayParams", parse: cv, targets: ie, durableQueue: !0 },
  { kind: "effects.setSpectralParams", parse: dv, targets: ie, durableQueue: !0 },
  { kind: "effects.reorderAudioChain", parse: lv, targets: ie, durableQueue: !0 },
  { kind: "effects.restoreChain", parse: uv, targets: ie, durableQueue: !0 },
  {
    kind: "effects.removeAudioEffect",
    parse: pv,
    targets: ie,
    durableQueue: !0
  },
  { kind: "effects.setReverbParams", parse: av, targets: ie, durableQueue: !0 },
  { kind: "effects.setSynthParams", parse: mv, targets: ie, durableQueue: !0 },
  { kind: "instruments.setTrackInstrument", parse: fv, targets: ie, durableQueue: !0 },
  { kind: "instruments.removeTrackInstrument", parse: (e) => qi("instruments.removeTrackInstrument", e), targets: ie, durableQueue: !0 },
  { kind: "effects.setArpeggiatorParams", parse: hv, targets: ie, durableQueue: !0 },
  { kind: "effects.removeArpeggiator", parse: (e) => qi("effects.removeArpeggiator", e), targets: ie, durableQueue: !0 },
  { kind: "effects.setMasterEqParams", parse: gv, targets: ee, durableQueue: !0 },
  { kind: "effects.setMasterUtilityParams", parse: (e) => io("utility", "effects.setMasterUtilityParams", e), targets: ee, durableQueue: !0 },
  { kind: "effects.setMasterLimiterParams", parse: (e) => io("limiter", "effects.setMasterLimiterParams", e), targets: ee, durableQueue: !0 },
  { kind: "effects.setMasterModulationParams", parse: (e) => $i(e, "master"), targets: ee, durableQueue: !0 },
  { kind: "effects.setMasterGateParams", parse: (e) => io("gate", "effects.setMasterGateParams", e), targets: ee, durableQueue: !0 },
  { kind: "effects.setMasterCompressorParams", parse: bv, targets: ee, durableQueue: !0 },
  { kind: "effects.setMasterSaturatorParams", parse: vv, targets: ee, durableQueue: !0 },
  { kind: "effects.setMasterDelayParams", parse: kv, targets: ee, durableQueue: !0 },
  { kind: "effects.setMasterSpectralParams", parse: wv, targets: ee, durableQueue: !0 },
  { kind: "effects.setMasterReverbParams", parse: yv, targets: ee, durableQueue: !0 },
  { kind: "effects.reorderMasterAudioChain", parse: Iv, targets: ee, durableQueue: !0 },
  { kind: "automation.setEnvelope", parse: Sv, targets: ie, durableQueue: !0 },
  { kind: "automation.deleteEnvelope", parse: xv, targets: ie, durableQueue: !0 }
], Ev = qd.map((e) => e.kind), Pv = (e) => Av(e) ? qd.find((t) => t.kind === e) : void 0, Av = (e) => typeof e == "string" && Ev.some((t) => t === e), _v = (e) => !N(e) || !N(e.payload) ? null : Pv(e.kind)?.parse(e.payload) ?? null;
Xh(
  _v,
  Gh((e) => e !== null)
);
const Xt = {
  maxEntities: 64,
  maxMappings: 64,
  maxMidiNotes: 500,
  maxAutomationPoints: 1e3,
  maxWarpMarkers: 1e3,
  maxSends: 256
}, zv = [
  "track.delete",
  "track.ungroup",
  "clip.delete",
  "effect.remove",
  "instrument.remove",
  "arpeggiator.remove",
  "automation.delete",
  "sidechain.remove",
  "asset.delete",
  "timeline.range.delete"
];
new Set(zv);
const fr = "v1", Hd = "v2", z = R().min(1).max(256), Tv = (e) => Array.from(e).some((t) => {
  const r = t.charCodeAt(0);
  return r <= 31 || r === 127;
}), Te = z.refine(
  (e) => e !== "." && e !== ".." && !Tv(e) && !/[/\\?#]|%(?:[01][0-9a-f]|7f|2f|5c|3f|23)/i.test(e),
  "Project IDs must be opaque URL-safe identifiers."
), hr = R().min(1).max(256), Oe = R().trim().min(1).max(120), $ = k().finite(), Z = $.min(0), gr = R().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/), Fn = ce([
  gr,
  l("clip-audio"),
  l("clip-midi"),
  l("clip-recording")
]), fa = P(["track", "group", "return"]), Mt = k().int().nonnegative(), Ze = R().regex(/^[0-9a-f]{64}$/, "Request digest must be a lowercase SHA-256 hex digest."), Ld = R().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/, "Approval tokens must be URL-safe opaque values."), Nn = R().min(1).max(2048).regex(/^[\x20-\x7e]+$/, "Cursor must contain printable ASCII characters only."), B = {
  maxActions: 100,
  maxSerializedBodyBytes: 256 * 1024,
  maxRecoveryEntities: Xt.maxEntities,
  maxRecoveryMappings: Xt.maxMappings,
  maxRecoveryMidiNotes: Xt.maxMidiNotes,
  maxRecoveryAutomationPoints: Xt.maxAutomationPoints,
  maxRecoveryWarpMarkers: Xt.maxWarpMarkers,
  maxRecoverySends: Xt.maxSends,
  maxAssetsPerSnapshot: 1e3,
  maxAssetFoldersPerSnapshot: 500,
  maxAssetUploadBytes: 10 * 1024 * 1024,
  maxMidiNotesPerCommit: 500,
  maxAutomationPointsPerCommit: 1e3,
  maxErrorDetails: 16,
  defaultHistoryPageSize: 50,
  maxHistoryPageSize: 100,
  defaultRecoveryPageSize: 50,
  maxRecoveryPageSize: 100
}, _t = {
  ...B,
  maxMidiPerformanceEventsPerCommit: 500,
  maxMidiPerformanceEventsPerClip: 500,
  maxMidiEventsPerArray: 500
}, Ft = J("source", [
  c({ source: l("persisted"), id: z }).strict(),
  c({ source: l("client"), clientRef: hr }).strict()
]), Re = Ft.describe("Track reference"), kt = Ft.describe("Clip reference"), yr = Ft.describe("Effect reference"), ha = c({ source: l("persisted"), id: z }).strict(), Ud = Ft.describe("Group track reference"), Rv = Ft.describe("Output track reference"), Cv = Ft.describe("Send target track reference"), Mv = Ft.describe("Sidechain source track reference"), Zd = Ft.describe("Sidechain target track reference"), Kr = J("kind", [
  c({ kind: l("track"), track: Re }).strict(),
  c({ kind: l("master") }).strict()
]), $n = c({
  kind: l("track"),
  track: Re
}).strict(), Dv = P(["cloud-project", "local-project"]), _o = c({
  version: l(fr),
  executionTarget: Dv,
  actionKinds: T(R()).readonly(),
  approvals: c({
    requiredForDestructiveActions: l(!0),
    expiresInSeconds: l(600),
    tool: l("control_request_approval")
  }).strict(),
  recovery: c({
    supportedKinds: T(R().min(1).max(64)).readonly(),
    unavailableKinds: T(R().min(1).max(64)).readonly(),
    expiresInSeconds: l(10080 * 60)
  }).strict(),
  limits: c({
    maxActions: k().int().positive(),
    maxSerializedBodyBytes: k().int().positive(),
    maxRecoveryEntities: k().int().positive(),
    maxRecoveryMappings: k().int().positive(),
    maxRecoveryMidiNotes: k().int().positive(),
    maxRecoveryAutomationPoints: k().int().positive(),
    maxRecoveryWarpMarkers: k().int().positive(),
    maxRecoverySends: k().int().positive(),
    maxAssetsPerSnapshot: k().int().positive(),
    maxAssetFoldersPerSnapshot: k().int().positive(),
    maxAssetUploadBytes: k().int().positive(),
    maxMidiNotesPerCommit: k().int().positive(),
    maxAutomationPointsPerCommit: k().int().positive(),
    maxErrorDetails: k().int().positive(),
    defaultHistoryPageSize: k().int().positive(),
    maxHistoryPageSize: k().int().positive(),
    defaultRecoveryPageSize: k().int().positive(),
    maxRecoveryPageSize: k().int().positive()
  }).strict()
}).strict(), jd = c({}).strict(), Vv = _o.extend({
  version: l(Hd),
  limits: _o.shape.limits.extend({
    maxMidiPerformanceEventsPerCommit: k().int().positive(),
    maxMidiPerformanceEventsPerClip: k().int().positive(),
    maxMidiEventsPerArray: k().int().positive(),
    maxMidiMappingsPerClip: k().int().positive()
  }).strict()
}).strict(), Kd = c({}).strict(), Ov = c({
  kind: l("project.rename"),
  name: Oe
}).strict(), Bv = c({
  kind: l("project.settings.set"),
  tempoBpm: $.int().min(30).max(300).optional(),
  timeSignatureNumerator: $.int().min(1).max(32).optional(),
  timeSignatureDenominator: ce([
    l(1),
    l(2),
    l(4),
    l(8),
    l(16),
    l(32)
  ]).optional(),
  loopEnabled: M().optional(),
  loopStartSec: Z.optional(),
  loopEndSec: Z.optional()
}).strict().refine((e) => Object.keys(e).length > 1, "Project settings action must change a setting."), Fv = c({
  kind: l("track.create"),
  clientRef: hr.optional(),
  name: Oe.optional(),
  index: k().int().nonnegative().optional(),
  trackKind: P(["audio", "instrument"]).optional(),
  channelRole: fa.optional(),
  color: gr.optional()
}).strict(), Nv = c({
  kind: l("track.rename"),
  track: Re,
  name: Oe
}).strict(), $v = c({
  kind: l("track.mix.set"),
  track: Re,
  volume: $.min(0).max(2).optional(),
  muted: M().optional(),
  soloed: M().optional()
}).strict().refine((e) => Object.keys(e).length > 2, "Track mix action must change a value."), qv = c({
  kind: l("track.routing.set"),
  track: Re,
  output: Rv.nullable().optional(),
  sends: T(c({
    target: Cv,
    amount: $.min(0).max(2),
    tap: P(["pre-fx", "pre-fader", "post-fader"]).optional()
  }).strict()).max(64).optional()
}).strict().refine((e) => Object.keys(e).length > 2, "Track routing action must change routing."), Hv = c({
  kind: l("track.reorder"),
  tracks: T(c({
    track: Re,
    index: k().int().nonnegative(),
    group: Ud.nullable()
  }).strict()).min(1).max(500)
}).strict(), Lv = c({
  kind: l("track.group.set"),
  track: Re,
  group: Ud.nullable()
}).strict(), Uv = c({
  kind: l("track.delete"),
  track: Re
}).strict(), Zv = c({
  kind: l("track.collapsed.set"),
  track: Re,
  collapsed: M()
}).strict(), jv = c({
  kind: l("track.color.set"),
  track: Re,
  color: gr.nullable()
}).strict(), Kv = c({
  kind: l("track.color.cascade"),
  root: Re,
  color: gr.nullable(),
  cascadeClipColors: M()
}).strict(), Wv = c({
  kind: l("track.ungroup"),
  group: Re
}).strict(), Gv = st.shape.notes.element, Wd = {
  inputChannel: st.shape.inputChannel.nullable(),
  cc: st.shape.cc,
  pitchBends: st.shape.pitchBends,
  channelPressure: st.shape.channelPressure,
  polyPressure: st.shape.polyPressure,
  mappings: st.shape.mappings
}, Qv = (e, t) => {
  const r = [
    ...e.notes,
    ...e.cc ?? [],
    ...e.pitchBends ?? [],
    ...e.channelPressure ?? [],
    ...e.polyPressure ?? []
  ].flatMap((a) => a.id === void 0 ? [] : [a.id]), n = [
    e.notes,
    e.cc ?? [],
    e.pitchBends ?? [],
    e.channelPressure ?? [],
    e.polyPressure ?? []
  ];
  n.some((a) => a.length > _t.maxMidiEventsPerArray) && t.addIssue({ code: "custom", message: `MIDI event arrays support at most ${_t.maxMidiEventsPerArray} events.` }), n.reduce((a, i) => a + i.length, 0) > _t.maxMidiPerformanceEventsPerClip && t.addIssue({ code: "custom", message: `MIDI clips support at most ${_t.maxMidiPerformanceEventsPerClip} performance events.` }), new Set(r).size !== r.length && t.addIssue({ code: "custom", message: "MIDI event IDs must be unique." });
  const o = (e.mappings ?? []).map((a) => a.id);
  new Set(o).size !== o.length && t.addIssue({ code: "custom", message: "MIDI mapping IDs must be unique." });
}, Jv = (e, t) => {
  const r = [
    ...e.notes,
    ...e.cc ?? [],
    ...e.pitchBends ?? [],
    ...e.channelPressure ?? [],
    ...e.polyPressure ?? []
  ].flatMap((o) => o.id === void 0 ? [] : [o.id]);
  new Set(r).size !== r.length && t.addIssue({ code: "custom", message: "MIDI event IDs must be unique." });
  const n = (e.mappings ?? []).map((o) => o.id);
  new Set(n).size !== n.length && t.addIssue({ code: "custom", message: "MIDI mapping IDs must be unique." });
}, ga = c({
  fadeInStartSec: Z.optional(),
  fadeInSec: Z,
  fadeOutSec: Z,
  fadeOutEndSec: Z.optional(),
  fadeInCurve: $,
  fadeOutCurve: $,
  fadeInCurvePosition: $.optional(),
  fadeOutCurvePosition: $.optional()
}).strict(), ya = c({
  enabled: M(),
  sourceBpm: $.min(30).max(300).optional(),
  sourceBeatOffset: $.optional(),
  markers: T(c({
    id: z,
    sourceBeat: $,
    timelineBeat: $
  }).strict()).max(1e3).optional(),
  mode: P(["repitch", "stretch"])
}).strict(), Xv = c({
  kind: l("clip.midi.create"),
  clientRef: hr.optional(),
  track: Re,
  name: Oe.optional(),
  startSec: Z,
  duration: $.positive(),
  wave: P(["sine", "square", "sawtooth", "triangle"]),
  notes: T(Gv).max(_t.maxMidiEventsPerArray),
  gain: $.min(0).max(2).optional(),
  ...Wd
}).strict().superRefine(Qv), Yv = c({
  kind: l("clip.audio.create"),
  clientRef: hr.optional(),
  track: Re,
  asset: ha,
  name: Oe.optional(),
  startSec: Z.optional(),
  duration: $.positive().optional(),
  gain: $.min(0).max(2).optional(),
  color: gr.optional(),
  leftPadSec: Z.optional(),
  bufferOffsetSec: Z.optional(),
  midiOffsetBeats: Z.optional(),
  fades: ga.optional(),
  audioWarp: ya.optional()
}).strict(), ek = c({
  kind: l("clip.source.set"),
  clip: kt,
  asset: ha
}).strict(), tk = c({
  kind: l("clip.midi.set"),
  clip: kt,
  wave: R(),
  // Existing MIDI clips can carry finite historical note values that are no
  // longer legal writes. The resolver compares this read envelope to the
  // persisted clip before requiring changed values to meet strict write rules.
  notes: T(c({
    id: z.optional(),
    beat: $,
    length: $,
    pitch: $,
    velocity: $.optional(),
    channel: $.optional()
  }).strict()),
  gain: $.optional(),
  ...Wd
}).strict().superRefine(Jv), rk = c({
  kind: l("clip.fades.set"),
  clip: kt,
  fades: ga
}).strict(), nk = c({
  kind: l("clip.audioWarp.set"),
  clip: kt,
  audioWarp: ya
}).strict(), ok = c({
  kind: l("clip.color.set"),
  clip: kt,
  color: Fn.nullable()
}).strict(), ak = c({
  kind: l("clip.move"),
  clip: kt,
  track: Re,
  startSec: Z
}).strict(), ik = c({
  kind: l("clip.timing.set"),
  clip: kt,
  duration: $.positive().optional(),
  gain: $.min(0).max(2).optional(),
  fadeInSec: Z.optional(),
  fadeOutSec: Z.optional(),
  leftPadSec: Z.optional(),
  bufferOffsetSec: Z.optional(),
  midiOffsetBeats: Z.optional()
}).strict().refine((e) => Object.keys(e).length > 2, "Clip timing action must change a value."), sk = c({
  kind: l("clip.rename"),
  clip: kt,
  name: Oe
}).strict(), ck = c({
  kind: l("clip.delete"),
  clip: kt
}).strict(), dk = c({
  kind: l("timeline.range.delete"),
  tracks: T(Re).min(1).max(500),
  startSec: Z,
  endSec: Z
}).strict().superRefine((e, t) => {
  e.endSec <= e.startSec && t.addIssue({ code: "custom", message: "Range end must be greater than range start.", path: ["endSec"] });
  const r = e.tracks.map((n) => n.source === "persisted" ? `persisted:${n.id}` : `client:${n.clientRef}`);
  new Set(r).size !== r.length && t.addIssue({ code: "custom", message: "Range tracks must be unique.", path: ["tracks"] });
}), lk = c({
  kind: l("master.volume.set"),
  volume: $.min(0).max(2)
}).strict(), ba = P(["utility", "eq", "autofilter", "gate", "compressor", "saturator", "limiter", "lofi", "chorus", "flanger", "phaser", "tremolo", "autopan", "ensemble", "delay", "reverb", "spectral"]), uk = c({
  kind: l("effect.upsert"),
  target: Kr,
  effect: yr.optional(),
  clientRef: hr.optional(),
  effectKind: ba,
  params: ut().optional()
}).strict().superRefine((e, t) => {
  e.effect !== void 0 && e.clientRef !== void 0 && t.addIssue({
    code: "custom",
    message: "Effect upsert cannot provide both an existing effect ref and a creation client ref.",
    path: ["clientRef"]
  });
  const r = bb.safeParse({
    effectKind: e.effectKind,
    ...e.params === void 0 ? {} : { params: e.params }
  });
  r.success || t.addIssue({ code: "custom", message: r.error.message, path: ["params"] });
}), pk = c({
  kind: l("effect.remove"),
  target: Kr,
  effectKind: ba,
  effect: c({ source: l("persisted"), id: z }).strict()
}).strict(), mk = c({
  kind: l("effect.reorder"),
  target: Kr,
  order: T(c({
    effect: yr,
    kind: ba
  }).strict()).max(64)
}).strict(), fk = c({
  kind: l("instrument.set"),
  target: $n,
  instrumentKind: P(["synth", "drum-rack", "sampler", "granular"]),
  params: ut().optional()
}).strict().superRefine((e, t) => {
  const r = vb.safeParse({
    instrumentKind: e.instrumentKind,
    ...e.params === void 0 ? {} : { params: e.params }
  });
  r.success || t.addIssue({ code: "custom", message: r.error.message, path: ["params"] });
}), hk = c({
  kind: l("arpeggiator.set"),
  target: $n,
  params: _d
}).strict(), gk = c({
  kind: l("instrument.remove"),
  target: $n
}).strict(), yk = c({
  kind: l("arpeggiator.remove"),
  target: $n
}).strict(), Gd = c({
  id: z,
  timeSec: Z,
  value: $,
  interpolation: P(["linear", "hold"])
}).strict(), bk = c({
  kind: l("automation.set"),
  target: Kr,
  effect: yr.optional(),
  parameterId: z,
  enabled: M(),
  points: T(Gd).max(B.maxAutomationPointsPerCommit)
}).strict(), vk = c({
  kind: l("automation.delete"),
  target: Kr,
  effect: yr.optional(),
  parameterId: z
}).strict(), kk = c({
  kind: l("sidechain.set"),
  source: Mv,
  target: Zd,
  effect: yr
}).strict(), wk = c({
  kind: l("sidechain.remove"),
  target: Zd,
  effect: yr
}).strict(), Ik = c({
  kind: l("asset.delete"),
  asset: ha
}).strict(), Sk = c({
  kind: l("recovery.restore"),
  recovery: c({ id: z }).strict()
}).strict(), xk = ce([
  Ov,
  Bv,
  Fv,
  Nv,
  $v,
  qv,
  Hv,
  Lv,
  Uv,
  Zv,
  jv,
  Kv,
  Wv,
  Xv,
  Yv,
  ek,
  tk,
  rk,
  nk,
  ok,
  ak,
  ik,
  sk,
  ck,
  dk,
  lk,
  uk,
  pk,
  mk,
  fk,
  gk,
  hk,
  yk,
  bk,
  vk,
  kk,
  wk,
  Ik,
  Sk
]), Ek = (e) => {
  if (e.kind === "track.create" || e.kind === "clip.midi.create" || e.kind === "clip.audio.create" || e.kind === "effect.upsert") return e.clientRef;
}, Pk = (e) => {
  const t = /* @__PURE__ */ new Set(), r = /* @__PURE__ */ new Set();
  for (const n of e) {
    const o = Ek(n);
    o !== void 0 && (t.has(o) && r.add(o), t.add(o));
  }
  return [...r].sort();
}, va = (e, t) => {
  let r = 0, n = 0;
  for (const a of e.actions) {
    if (a.kind === "clip.midi.create" || a.kind === "clip.midi.set") {
      const i = a.notes.length + (a.cc?.length ?? 0) + (a.pitchBends?.length ?? 0) + (a.channelPressure?.length ?? 0) + (a.polyPressure?.length ?? 0);
      (a.kind === "clip.midi.create" || i <= _t.maxMidiPerformanceEventsPerClip) && (r += i);
    }
    a.kind === "automation.set" && (n += a.points.length);
  }
  r > _t.maxMidiPerformanceEventsPerCommit && t.addIssue({
    code: "custom",
    message: `Control request exceeds ${_t.maxMidiPerformanceEventsPerCommit} MIDI performance events.`,
    path: ["actions"]
  }), n > B.maxAutomationPointsPerCommit && t.addIssue({
    code: "custom",
    message: `Control request exceeds ${B.maxAutomationPointsPerCommit} automation points.`,
    path: ["actions"]
  });
  const o = Pk(e.actions);
  o.length > 0 && t.addIssue({
    code: "custom",
    message: `Creation client refs must be unique: ${o.join(", ")}.`,
    path: ["actions"]
  });
}, ka = {
  version: l(fr),
  projectId: Te,
  expectedRevision: Mt.optional(),
  actions: T(xk).min(1).max(B.maxActions)
}, Qd = R().min(8).max(128).regex(/^[A-Za-z0-9._~-]+$/, "Idempotency keys may contain only ASCII letters, digits, dot, underscore, tilde, and hyphen."), Jd = c({
  ...ka,
  idempotencyKey: Qd,
  approvalToken: Ld.optional()
}).strict().superRefine(va), Fr = c({
  version: l(fr),
  code: P([
    "invalid-request",
    "validation",
    "unsupported-action",
    "revision-conflict",
    "idempotency-conflict",
    "forbidden",
    "authorization",
    "not-found",
    "limit-exceeded",
    "approval-required",
    "internal"
  ]),
  message: R().min(1).max(1e3),
  actionIndex: k().int().nonnegative().optional(),
  details: rc(R().min(1).max(64), R().max(1e3)).refine((e) => Object.keys(e).length <= B.maxErrorDetails).optional()
}).strict(), Xd = c(ka).strict().superRefine(va), Yd = c(ka).strict().superRefine(va), Ak = c({
  tracks: k().int().nonnegative(),
  clips: k().int().nonnegative(),
  processors: k().int().nonnegative(),
  automation: k().int().nonnegative(),
  sidechains: k().int().nonnegative(),
  assets: k().int().nonnegative(),
  routingChanges: k().int().nonnegative()
}).strict(), _k = c({
  required: M(),
  actionIndexes: T(k().int().nonnegative()).max(B.maxActions),
  actionKinds: T(R().min(1).max(64)).max(B.maxActions),
  impact: Ak,
  requestDigest: Ze,
  baseRevision: Mt,
  expiresInSeconds: l(600)
}).strict(), zk = c({
  entity: P(["track", "clip", "effect"]),
  clientRef: hr,
  id: z,
  persisted: M()
}).strict(), Tk = c({
  code: R().min(1).max(64),
  message: R().min(1).max(1e3),
  actionIndex: k().int().nonnegative().optional()
}).strict(), Rk = c({
  actionIndex: k().int().nonnegative(),
  kind: R().min(1).max(64),
  description: R().min(1).max(1e3)
}).strict(), Ck = c({
  actionCount: k().int().nonnegative().max(B.maxActions),
  changes: T(Rk).max(B.maxActions)
}).strict(), wa = c({
  actionIndex: k().int().nonnegative(),
  id: z,
  kind: P([
    "clip.delete",
    "effect.remove",
    "instrument.remove",
    "arpeggiator.remove",
    "automation.delete",
    "sidechain.remove",
    "asset.delete",
    "track.delete",
    "track.ungroup",
    "timeline.range.delete"
  ]),
  expiresAt: k().int().nonnegative()
}).strict(), Mk = P(["track", "clip", "effect", "automation", "sidechain", "asset"]), el = c({
  actionIndex: k().int().nonnegative(),
  recoveryId: z,
  entities: T(c({
    entity: Mk,
    sourceId: z,
    restoredId: z
  }).strict()).max(B.maxRecoveryMappings)
}).strict(), tl = {
  version: l(fr),
  projectId: Te,
  priorRevision: Mt,
  requestDigest: Ze,
  resolvedRefs: T(zk).max(B.maxActions),
  warnings: T(Tk).max(B.maxActions),
  changeSummary: Ck
}, Dk = c({
  ...tl,
  revision: Mt,
  applied: M(),
  approval: _k.optional()
}).strict(), Vk = c({
  version: l(fr),
  approvalToken: Ld,
  requestDigest: Ze,
  baseRevision: Mt,
  actionIndexes: T(k().int().nonnegative()).min(1).max(B.maxActions),
  expiresAt: k().int().nonnegative()
}).strict(), Ok = c({
  ...tl,
  revision: Mt,
  applied: M(),
  idempotencyReplay: M(),
  recoveries: T(wa).max(B.maxActions).default([]),
  restored: T(el).max(B.maxActions).default([])
}).strict(), qn = c({
  projectId: Te
}).strict(), rl = c({
  projectId: Te,
  cursor: Nn.optional(),
  limit: k().int().positive().max(B.maxHistoryPageSize).default(B.defaultHistoryPageSize)
}).strict(), Bk = c({
  id: z,
  projectId: Te,
  actorSubject: z,
  actorIssuer: z.optional(),
  actorTokenIdentifier: z.optional(),
  actorRole: P(["owner", "editor", "viewer"]),
  idempotencyKey: Qd,
  requestDigest: Ze,
  priorRevision: Mt,
  revision: Mt,
  applied: M(),
  createdAt: k().int().nonnegative(),
  recoveries: T(wa).max(B.maxActions).default([]),
  restored: T(el).max(B.maxActions).default([])
}).strict(), Fk = c({
  entries: T(Bk).max(B.maxHistoryPageSize),
  continueCursor: Nn,
  isDone: M()
}).strict(), nl = c({
  projectId: Te,
  cursor: Nn.optional(),
  limit: k().int().positive().max(B.maxRecoveryPageSize).default(B.defaultRecoveryPageSize)
}).strict(), Nk = c({
  entries: T(wa).max(B.maxRecoveryPageSize),
  continueCursor: Nn,
  isDone: M()
}).strict(), Hi = ce([
  c({ trackId: z }).strict(),
  c({ master: l(!0) }).strict()
]), $k = c({
  id: z,
  name: Oe,
  index: k().int().nonnegative(),
  kind: P(["audio", "instrument"]),
  channelRole: fa,
  groupId: z.optional(),
  volume: $,
  muted: M(),
  soloed: M(),
  outputTargetId: z.optional(),
  sends: T(c({ targetTrackId: z, amount: $, tap: P(["pre-fx", "pre-fader", "post-fader"]).optional() }).strict()),
  collapsed: M(),
  color: Fn.optional()
}).strict(), Ia = P([
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
  "audio/webm"
]), Wr = P(["upload", "url", "recording"]), ol = c({
  id: z,
  name: Oe,
  createdAt: k().int().nonnegative(),
  updatedAt: k().int().nonnegative()
}).strict(), al = c({
  id: z,
  name: Oe,
  sourceKind: Wr,
  mimeType: Ia,
  sizeBytes: k().int().positive().max(B.maxAssetUploadBytes),
  contentSha256: Ze,
  durationSec: Z.optional(),
  sampleRate: k().int().positive().optional(),
  channelCount: k().int().positive().max(64).optional(),
  folderId: z.optional(),
  createdAt: k().int().nonnegative(),
  updatedAt: k().int().nonnegative()
}).strict();
c({
  asset: al,
  idempotencyReplay: M()
}).strict();
c({
  folder: ol,
  applied: M()
}).strict();
const qk = c({
  wave: R(),
  gain: $.optional(),
  notes: T(c({
    beat: $,
    length: $,
    pitch: $,
    velocity: $.optional()
  }).strict())
}).strict(), il = c({
  id: z,
  trackId: z,
  name: Oe,
  startSec: Z,
  duration: $.positive(),
  gain: $.optional(),
  leftPadSec: Z,
  bufferOffsetSec: Z,
  midiOffsetBeats: Z,
  fades: ga.optional(),
  color: Fn.optional(),
  audioWarp: ya.optional(),
  source: c({
    assetId: z,
    sourceKind: Wr,
    durationSec: Z.optional(),
    sampleRate: k().int().positive().optional(),
    channelCount: k().int().positive().max(64).optional()
  }).strict().optional(),
  midi: qk.optional()
}).strict(), sl = c({
  version: l(fr),
  project: c({
    id: Te,
    name: Oe,
    revision: k().int().nonnegative(),
    tempoBpm: $,
    timeSignature: c({ numerator: k().int().positive(), denominator: k().int().positive() }).strict(),
    loop: c({ enabled: M(), startSec: Z, endSec: Z }).strict(),
    masterVolume: $,
    updatedAt: k().int().nonnegative()
  }).strict(),
  tracks: T($k),
  clips: T(il),
  processors: T(c({
    id: z,
    target: Hi,
    instanceId: z.optional(),
    index: k().int().nonnegative(),
    processor: zd
  }).strict()),
  automation: T(c({
    target: Hi,
    effectInstanceId: z.optional(),
    parameterId: z,
    enabled: M(),
    points: T(Gd)
  }).strict()),
  sidechains: T(c({
    sourceTrackId: z,
    targetTrackId: z,
    effectInstanceId: z
  }).strict()),
  assets: T(al).max(B.maxAssetsPerSnapshot),
  assetFolders: T(ol).max(B.maxAssetFoldersPerSnapshot)
}).strict(), Hk = il.extend({
  midi: ea.optional()
}).strict(), Lk = sl.extend({
  version: l(Hd),
  clips: T(Hk)
}).strict(), Uk = c({
  id: z,
  timeSec: $,
  value: $,
  interpolation: P(["linear", "hold"])
}).strict(), Zk = c({
  fadeInStartSec: Z.optional(),
  fadeInSec: Z,
  fadeOutSec: Z,
  fadeOutEndSec: Z.optional(),
  fadeInCurve: $,
  fadeOutCurve: $,
  fadeInCurvePosition: $.optional(),
  fadeOutCurvePosition: $.optional()
}).strict(), jk = c({
  enabled: M(),
  sourceBpm: $.min(30).max(300).optional(),
  sourceBeatOffset: $.optional(),
  markers: T(c({
    id: z,
    sourceBeat: $,
    timelineBeat: $
  }).strict()).max(1e3).optional(),
  mode: P(["repitch", "stretch"])
}).strict(), Kk = c({
  wave: R(),
  gain: $.optional(),
  notes: T(c({
    beat: $,
    length: $.positive(),
    pitch: k().int().min(0).max(127),
    velocity: $.min(0).max(1).optional()
  }).strict())
}).strict(), Hn = c({
  projectId: Te,
  trackId: z,
  startSec: Z,
  duration: $.positive(),
  sourceAssetKey: z.optional(),
  sourceKind: Wr.optional(),
  sourceDurationSec: Z.optional(),
  sourceSampleRate: k().int().positive().optional(),
  sourceChannelCount: k().int().positive().max(64).optional(),
  leftPadSec: Z.optional(),
  bufferOffsetSec: Z.optional(),
  audioWarp: jk.optional(),
  gain: $.optional(),
  fades: Zk.optional(),
  color: Fn.optional(),
  name: Oe.optional(),
  sampleUrl: R().min(1).max(2048).optional(),
  midi: Kk.optional(),
  midiOffsetBeats: $.optional()
}).strict(), Wk = c({
  projectId: Te,
  ownerUserId: z,
  role: P(["owner", "editor", "viewer"]).optional()
}).strict(), Gk = c({
  projectId: Te,
  localActorSubject: z
}).strict(), Qt = ce([
  Wk,
  Gk
]), Qk = c({
  projectId: Te,
  assetKey: z,
  sourceKind: Wr,
  name: Oe,
  mimeType: Ia,
  sizeBytes: k().int().positive().max(B.maxAssetUploadBytes),
  contentSha256: Ze,
  r2Key: R().min(1).max(2048),
  duration: Z.optional(),
  sampleRate: k().int().positive().optional(),
  channelCount: k().int().positive().max(64).optional(),
  ownerUserId: z,
  folderId: z.optional(),
  createdAt: k().int().nonnegative(),
  updatedAt: k().int().nonnegative()
}).strict(), Jk = c({
  projectId: Te,
  assetKey: z,
  sourceKind: Wr,
  name: Oe,
  mimeType: Ia,
  sizeBytes: k().int().positive().max(B.maxAssetUploadBytes),
  contentSha256: Ze,
  storagePath: R().min(1).max(2048),
  duration: Z.optional(),
  sampleRate: k().int().positive().optional(),
  channelCount: k().int().positive().max(64).optional(),
  folderId: z.optional(),
  missing: M().optional(),
  originalFileName: R().min(1).max(1024).optional(),
  originalLastModified: k().int().nonnegative().optional(),
  createdAt: k().int().nonnegative(),
  updatedAt: k().int().nonnegative()
}).strict(), Sa = ce([
  Qk,
  Jk
]), Gr = c({
  projectId: Te,
  targetKind: P(["track", "master"]),
  trackId: z.optional(),
  effectInstanceId: z.optional(),
  targetKey: z,
  parameterId: z,
  enabled: M(),
  points: T(Uk).max(B.maxRecoveryAutomationPoints),
  updatedAt: k().int().nonnegative()
}).strict().superRefine((e, t) => {
  e.targetKind === "track" && e.trackId === void 0 && t.addIssue({ code: "custom", message: "Track automation needs a track ID.", path: ["trackId"] }), e.targetKind === "master" && e.trackId !== void 0 && t.addIssue({ code: "custom", message: "Master automation cannot carry a track ID.", path: ["trackId"] });
}), Ln = c({
  projectId: Te,
  sourceTrackId: z,
  targetTrackId: z,
  effectInstanceId: z
}).strict(), Xk = c({
  projectId: Te,
  target: ce([
    c({ kind: l("master") }).strict(),
    c({ kind: l("track"), trackId: z }).strict()
  ]),
  index: k().int().nonnegative(),
  processor: zd,
  instanceId: z.optional(),
  createdAt: k().int().nonnegative()
}).strict(), Ke = c({
  effects: T(c({
    id: z,
    effect: Xk
  }).strict()).max(B.maxRecoveryEntities),
  automation: T(c({ id: z, automation: Gr }).strict()).max(B.maxRecoveryEntities),
  sidechains: T(c({ id: z, sidechain: Ln }).strict()).max(B.maxRecoveryEntities)
}).strict(), Nr = c({
  projectId: Te,
  name: Oe,
  index: k().int().nonnegative(),
  kind: P(["audio", "instrument"]).optional(),
  historyRef: z.optional(),
  groupId: z.optional(),
  collapsed: M().optional(),
  color: gr.optional(),
  mixer: c({
    volume: $.min(0).max(2),
    muted: M().optional(),
    soloed: M().optional(),
    channelRole: fa,
    outputTargetId: z.optional(),
    sends: T(c({
      targetId: z,
      amount: $.min(0).max(2),
      tap: P(["pre-fx", "pre-fader", "post-fader"]).optional()
    }).strict()).max(B.maxRecoverySends)
  }).strict()
}).strict(), Yk = c({
  id: z,
  track: Nr,
  ownership: Qt
}).strict(), xa = c({
  id: z,
  clip: Hn,
  ownership: Qt
}).strict(), Un = c({
  tracks: T(Yk).min(1).max(B.maxRecoveryEntities),
  clips: T(xa).max(B.maxRecoveryEntities),
  effects: Ke.shape.effects,
  automation: Ke.shape.automation,
  sidechains: Ke.shape.sidechains
}).strict().superRefine((e, t) => {
  const r = e.tracks.length + e.clips.length + e.effects.length + e.automation.length + e.sidechains.length, n = e.clips.reduce((m, h) => m + (h.clip.midi ? hb(h.clip.midi) : 0), 0), o = e.automation.reduce((m, h) => m + h.automation.points.length, 0), a = e.clips.reduce((m, h) => m + (h.clip.audioWarp?.markers?.length ?? 0), 0), i = e.tracks.reduce((m, h) => m + h.track.mixer.sends.length, 0);
  r > B.maxRecoveryEntities && t.addIssue({ code: "custom", message: "Recovery entity limit exceeded." }), r > B.maxRecoveryMappings && t.addIssue({ code: "custom", message: "Recovery mapping limit exceeded." }), n > B.maxRecoveryMidiNotes && t.addIssue({ code: "custom", message: "Recovery MIDI note limit exceeded." }), o > B.maxRecoveryAutomationPoints && t.addIssue({ code: "custom", message: "Recovery automation point limit exceeded." }), a > B.maxRecoveryWarpMarkers && t.addIssue({ code: "custom", message: "Recovery warp marker limit exceeded." }), i > B.maxRecoverySends && t.addIssue({ code: "custom", message: "Recovery send limit exceeded." });
  const s = (m, h) => {
    new Set(m).size !== m.length && t.addIssue({ code: "custom", message: "Recovery IDs must be unique.", path: h });
  };
  s(e.tracks.map((m) => m.id), ["tracks"]), s(e.clips.map((m) => m.id), ["clips"]), s(e.effects.map((m) => m.id), ["effects"]), s(e.automation.map((m) => m.id), ["automation"]), s(e.sidechains.map((m) => m.id), ["sidechains"]);
  const d = new Set(e.tracks.map((m) => m.id));
  for (const [m, h] of e.tracks.entries())
    h.track.groupId && !d.has(h.track.groupId) || h.track.mixer.outputTargetId && !d.has(h.track.mixer.outputTargetId) || h.ownership.projectId !== h.track.projectId && t.addIssue({ code: "custom", message: "Track ownership must belong to its project.", path: ["tracks", m, "ownership"] });
  for (const [m, h] of e.clips.entries())
    d.has(h.clip.trackId) || t.addIssue({ code: "custom", message: "Recovered clips must belong to recovered tracks.", path: ["clips", m, "clip", "trackId"] });
}), Ea = Un.extend({
  rootTrackId: z,
  survivors: T(c({
    id: z,
    before: Nr,
    after: Nr
  }).strict()).max(B.maxRecoveryEntities)
}).strict().superRefine((e, t) => {
  e.tracks.some((o) => o.id === e.rootTrackId) || t.addIssue({ code: "custom", message: "Deleted root must be captured.", path: ["rootTrackId"] });
  const r = new Set(e.tracks.map((o) => o.id)), n = e.survivors.map((o) => o.id);
  (new Set(n).size !== n.length || n.some((o) => r.has(o))) && t.addIssue({ code: "custom", message: "Recovery survivor IDs must be unique and distinct from deleted tracks.", path: ["survivors"] });
}), Pa = Un.extend({
  groupId: z,
  children: T(c({
    id: z,
    before: Nr,
    after: Nr
  }).strict()).max(B.maxRecoveryEntities)
}).strict().superRefine((e, t) => {
  (e.tracks.length !== 1 || e.tracks[0]?.id !== e.groupId) && t.addIssue({ code: "custom", message: "Ungroup recovery must capture exactly its group.", path: ["groupId"] });
  const r = e.children.map((n) => n.id);
  new Set(r).size !== r.length && t.addIssue({ code: "custom", message: "Ungroup children must be unique.", path: ["children"] });
});
J("kind", [
  c({ version: l(1), kind: l("clip.delete"), data: c({
    clip: Hn,
    clipId: z,
    ownership: Qt
  }).strict() }).strict(),
  c({ version: l(1), kind: l("asset.delete"), data: c({
    asset: Sa,
    assetId: z
  }).strict() }).strict(),
  c({ version: l(1), kind: l("automation.delete"), data: c({
    automation: Gr,
    automationId: z
  }).strict() }).strict(),
  c({ version: l(1), kind: l("sidechain.remove"), data: c({
    sidechain: Ln,
    sidechainId: z
  }).strict() }).strict(),
  c({ version: l(1), kind: l("effect.remove"), data: Ke }).strict(),
  c({ version: l(1), kind: l("instrument.remove"), data: Ke }).strict(),
  c({ version: l(1), kind: l("arpeggiator.remove"), data: Ke }).strict(),
  c({ version: l(1), kind: l("track.delete"), data: Ea }).strict(),
  c({ version: l(1), kind: l("track.ungroup"), data: Pa }).strict()
]);
const yn = Hn.extend({
  historyRef: z.optional(),
  midi: st.optional()
}).strict(), e0 = xa.extend({
  clip: yn
}).strict(), cl = Un.safeExtend({
  clips: T(e0).max(B.maxRecoveryEntities)
}).strict(), t0 = cl.safeExtend({
  rootTrackId: z,
  survivors: Ea.shape.survivors
}).strict(), r0 = cl.safeExtend({
  groupId: z,
  children: Pa.shape.children
}).strict(), dl = (e, t) => {
  const r = e.deletedClips.length + e.updatedClips.length + e.createdClips.length + e.automation.length, n = e.automation.reduce((s, d) => s + d.before.points.length, 0);
  r > B.maxRecoveryEntities && t.addIssue({ code: "custom", message: "Recovery entity limit exceeded." }), n > B.maxRecoveryAutomationPoints && t.addIssue({ code: "custom", message: "Recovery automation point limit exceeded." });
  const o = (s, d) => {
    new Set(s).size !== s.length && t.addIssue({ code: "custom", message: "Recovery IDs must be unique.", path: d });
  };
  o(e.range.trackIds, ["range", "trackIds"]), o(e.deletedClips.map((s) => s.id), ["deletedClips"]), o(e.updatedClips.map((s) => s.id), ["updatedClips"]), o(e.createdClips.map((s) => s.id), ["createdClips"]), o(e.automation.map((s) => s.id), ["automation"]);
  const a = new Set(e.deletedClips.map((s) => s.id));
  e.updatedClips.some((s) => a.has(s.id)) && t.addIssue({ code: "custom", message: "Range recovery clip deletes and updates must be distinct.", path: ["updatedClips"] });
  const i = new Set(e.range.trackIds);
  (e.deletedClips.some((s) => !i.has(s.before.trackId)) || e.updatedClips.some((s) => !i.has(s.before.trackId))) && t.addIssue({ code: "custom", message: "Range recovery clips must belong to selected tracks." });
}, ll = c({
  range: c({
    trackIds: T(z).min(1).max(B.maxRecoveryEntities),
    startSec: Z,
    endSec: Z
  }).strict().refine((e) => e.endSec > e.startSec, "Range end must be after range start."),
  deletedClips: T(c({
    id: z,
    before: yn,
    ownership: Qt
  }).strict()).max(B.maxRecoveryEntities),
  updatedClips: T(c({
    id: z,
    before: yn,
    expectedAfterDigest: Ze
  }).strict()).max(B.maxRecoveryEntities),
  createdClips: T(c({
    id: z,
    expectedAfterDigest: Ze,
    expectedOwnershipDigest: Ze
  }).strict()).max(B.maxRecoveryEntities),
  automation: T(c({
    id: z,
    before: Gr,
    expectedAfterDigest: Ze
  }).strict()).max(B.maxRecoveryEntities)
}).strict().superRefine(dl);
J("kind", [
  c({ version: l(2), kind: l("clip.delete"), data: c({
    clip: yn,
    clipId: z,
    ownership: Qt
  }).strict() }).strict(),
  c({ version: l(2), kind: l("asset.delete"), data: c({
    asset: Sa,
    assetId: z
  }).strict() }).strict(),
  c({ version: l(2), kind: l("automation.delete"), data: c({
    automation: Gr,
    automationId: z
  }).strict() }).strict(),
  c({ version: l(2), kind: l("sidechain.remove"), data: c({
    sidechain: Ln,
    sidechainId: z
  }).strict() }).strict(),
  c({ version: l(2), kind: l("effect.remove"), data: Ke }).strict(),
  c({ version: l(2), kind: l("instrument.remove"), data: Ke }).strict(),
  c({ version: l(2), kind: l("arpeggiator.remove"), data: Ke }).strict(),
  c({ version: l(2), kind: l("track.delete"), data: t0 }).strict(),
  c({ version: l(2), kind: l("track.ungroup"), data: r0 }).strict(),
  c({ version: l(2), kind: l("timeline.range.delete"), data: ll }).strict()
]);
const bn = Hn.extend({
  historyRef: z.optional(),
  midi: ea.optional()
}).strict(), n0 = xa.extend({
  clip: bn
}).strict(), o0 = (e, t) => {
  const r = e.tracks.length + e.clips.length + e.effects.length + e.automation.length + e.sidechains.length, n = e.automation.reduce((d, m) => d + m.automation.points.length, 0), o = e.clips.reduce((d, m) => d + (m.clip.audioWarp?.markers?.length ?? 0), 0), a = e.tracks.reduce((d, m) => d + m.track.mixer.sends.length, 0);
  r > B.maxRecoveryEntities && t.addIssue({ code: "custom", message: "Recovery entity limit exceeded." }), r > B.maxRecoveryMappings && t.addIssue({ code: "custom", message: "Recovery mapping limit exceeded." }), n > B.maxRecoveryAutomationPoints && t.addIssue({ code: "custom", message: "Recovery automation point limit exceeded." }), o > B.maxRecoveryWarpMarkers && t.addIssue({ code: "custom", message: "Recovery warp marker limit exceeded." }), a > B.maxRecoverySends && t.addIssue({ code: "custom", message: "Recovery send limit exceeded." });
  const i = (d, m) => {
    new Set(d).size !== d.length && t.addIssue({ code: "custom", message: "Recovery IDs must be unique.", path: m });
  };
  i(e.tracks.map((d) => d.id), ["tracks"]), i(e.clips.map((d) => d.id), ["clips"]), i(e.effects.map((d) => d.id), ["effects"]), i(e.automation.map((d) => d.id), ["automation"]), i(e.sidechains.map((d) => d.id), ["sidechains"]);
  const s = new Set(e.tracks.map((d) => d.id));
  for (const [d, m] of e.tracks.entries())
    m.track.groupId && !s.has(m.track.groupId) || m.track.mixer.outputTargetId && !s.has(m.track.mixer.outputTargetId) || m.ownership.projectId !== m.track.projectId && t.addIssue({ code: "custom", message: "Track ownership must belong to its project.", path: ["tracks", d, "ownership"] });
  for (const [d, m] of e.clips.entries())
    s.has(m.clip.trackId) || t.addIssue({ code: "custom", message: "Recovered clips must belong to recovered tracks.", path: ["clips", d, "clip", "trackId"] });
}, ul = c({
  ...Un.shape,
  clips: T(n0).max(B.maxRecoveryEntities)
}).strict().superRefine(o0), a0 = ul.extend({
  rootTrackId: z,
  survivors: Ea.shape.survivors
}).strict().superRefine((e, t) => {
  e.tracks.some((o) => o.id === e.rootTrackId) || t.addIssue({ code: "custom", message: "Deleted root must be captured.", path: ["rootTrackId"] });
  const r = new Set(e.tracks.map((o) => o.id)), n = e.survivors.map((o) => o.id);
  (new Set(n).size !== n.length || n.some((o) => r.has(o))) && t.addIssue({ code: "custom", message: "Recovery survivor IDs must be unique and distinct from deleted tracks.", path: ["survivors"] });
}), i0 = ul.extend({
  groupId: z,
  children: Pa.shape.children
}).strict().superRefine((e, t) => {
  (e.tracks.length !== 1 || e.tracks[0]?.id !== e.groupId) && t.addIssue({ code: "custom", message: "Ungroup recovery must capture exactly its group.", path: ["groupId"] });
  const r = e.children.map((n) => n.id);
  new Set(r).size !== r.length && t.addIssue({ code: "custom", message: "Ungroup children must be unique.", path: ["children"] });
}), s0 = c({
  ...ll.shape,
  deletedClips: T(c({
    id: z,
    before: bn,
    ownership: Qt
  }).strict()).max(B.maxRecoveryEntities),
  updatedClips: T(c({
    id: z,
    before: bn,
    expectedAfterDigest: Ze
  }).strict()).max(B.maxRecoveryEntities)
}).strict().superRefine(dl);
J("kind", [
  c({ version: l(2), kind: l("clip.delete"), data: c({
    clip: bn,
    clipId: z,
    ownership: Qt
  }).strict() }).strict(),
  c({ version: l(2), kind: l("asset.delete"), data: c({
    asset: Sa,
    assetId: z
  }).strict() }).strict(),
  c({ version: l(2), kind: l("automation.delete"), data: c({
    automation: Gr,
    automationId: z
  }).strict() }).strict(),
  c({ version: l(2), kind: l("sidechain.remove"), data: c({
    sidechain: Ln,
    sidechainId: z
  }).strict() }).strict(),
  c({ version: l(2), kind: l("effect.remove"), data: Ke }).strict(),
  c({ version: l(2), kind: l("instrument.remove"), data: Ke }).strict(),
  c({ version: l(2), kind: l("arpeggiator.remove"), data: Ke }).strict(),
  c({ version: l(2), kind: l("track.delete"), data: a0 }).strict(),
  c({ version: l(2), kind: l("track.ungroup"), data: i0 }).strict(),
  c({ version: l(2), kind: l("timeline.range.delete"), data: s0 }).strict()
]);
const Ge = "v1", Pe = "v2", Li = [Ge, Pe], pl = 1048576, Ui = 512 * 1024, Aa = 64 * 1024 * 1024, _a = 380 * 1024, c0 = 4 * Math.ceil(_a / 3), ml = Math.ceil(Aa / _a), d0 = 96, Qr = 6e4, rt = R().min(1).max(d0).regex(/^[A-Za-z0-9._-]+$/), Ne = l(Ge), ht = l(Pe), St = c({}).strict(), at = k().finite().min(0).max(86400), l0 = c({ seconds: at }).strict(), Dt = P([
  "host.status",
  "host.import.audio",
  "host.export.run",
  "host.export.status",
  "host.export.cancel",
  "transport.status",
  "transport.play",
  "transport.pause",
  "transport.stop",
  "transport.seek",
  "diagnostics.snapshot",
  "control.capabilities",
  "control.snapshot",
  "control.preview",
  "control.commit",
  "control.requestApproval",
  "control.history",
  "control.recoveries"
]), fl = jd, hl = qn, u0 = jd.extend({
  readVersion: l("v2").optional()
}).strict(), p0 = qn.extend({
  readVersion: l("v2").optional()
}).strict(), gl = Kd.extend({
  readVersion: l("v2")
}).strict(), yl = qn.extend({
  readVersion: l("v2")
}).strict(), Zn = {
  "host.status": St,
  "host.import.audio": c({
    source: J("kind", [
      c({ kind: l("path"), path: R().min(1).max(4096) }).strict(),
      c({ kind: l("picker") }).strict()
    ])
  }).strict(),
  "host.export.run": J("mode", [
    c({
      mode: l("mixdown"),
      format: P(["wav", "mp3", "ogg-opus", "flac"]),
      destination: J("kind", [
        c({ kind: l("file"), path: R().min(1).max(4096) }).strict(),
        c({ kind: l("file-picker") }).strict()
      ]),
      range: J("mode", [
        c({ mode: l("whole") }).strict(),
        c({ mode: l("loop"), startSec: at, endSec: at }).strict().refine((e) => e.startSec < e.endSec),
        c({ mode: l("custom"), startSec: at, endSec: at }).strict().refine((e) => e.startSec < e.endSec)
      ]),
      render: c({
        sampleRate: ce([l(44100), l(48e3), l(96e3)]),
        channels: ce([l(1), l(2)]),
        normalization: J("mode", [
          c({ mode: l("none") }).strict(),
          c({ mode: l("sample-peak"), targetDbfs: k().finite().min(-120).max(0) }).strict(),
          c({ mode: l("loudness"), targetLufs: k().finite().min(-36).max(-5), ceiling: k().finite().min(-12).max(0), limiting: P(["off", "true-peak"]) }).strict()
        ]),
        tail: J("mode", [
          c({ mode: l("none") }).strict(),
          c({ mode: l("fixed"), durationSec: k().finite().min(0).max(60) }).strict(),
          c({ mode: l("automatic"), thresholdDbfs: k().finite().min(-120).max(-20), holdSec: k().finite().min(0.1).max(10), maximumSec: k().finite().min(0.1).max(120) }).strict()
        ])
      }).strict(),
      encoding: c({
        mp3Bitrate: k().int().min(32e3).max(32e4).optional(),
        oggOpusBitrate: k().int().min(6e3).max(51e4).optional(),
        wav: ce([
          c({ codec: l("pcm-s16"), dither: P(["none", "tpdf"]) }).strict(),
          c({ codec: l("pcm-s24"), dither: P(["none", "tpdf"]) }).strict(),
          c({ codec: l("pcm-f32"), dither: l("none") }).strict()
        ])
      }).strict()
    }).strict(),
    c({
      mode: l("stems"),
      formats: T(P(["wav", "mp3", "ogg-opus", "flac"])).min(1).max(4).refine((e) => new Set(e).size === e.length),
      destination: J("kind", [
        c({ kind: l("directory"), path: R().min(1).max(4096) }).strict(),
        c({ kind: l("directory-picker") }).strict()
      ]),
      selection: J("kind", [
        c({ kind: l("all-tracks") }).strict(),
        c({ kind: l("selected-tracks"), trackIds: T(R().min(1).max(256)).min(1).max(500).refine((e) => new Set(e).size === e.length) }).strict()
      ]),
      stemMode: P(["dry-source", "post-track-fx", "reachable-routing", "channel-output", "full-master-contribution"]),
      range: J("mode", [
        c({ mode: l("whole") }).strict(),
        c({ mode: l("loop"), startSec: at, endSec: at }).strict().refine((e) => e.startSec < e.endSec),
        c({ mode: l("custom"), startSec: at, endSec: at }).strict().refine((e) => e.startSec < e.endSec)
      ]),
      render: c({
        sampleRate: ce([l(44100), l(48e3), l(96e3)]),
        channels: ce([l(1), l(2)]),
        normalization: J("mode", [
          c({ mode: l("none") }).strict(),
          c({ mode: l("sample-peak"), targetDbfs: k().finite().min(-120).max(0) }).strict(),
          c({ mode: l("loudness"), targetLufs: k().finite().min(-36).max(-5), ceiling: k().finite().min(-12).max(0), limiting: P(["off", "true-peak"]) }).strict()
        ]),
        tail: J("mode", [
          c({ mode: l("none") }).strict(),
          c({ mode: l("fixed"), durationSec: k().finite().min(0).max(60) }).strict(),
          c({ mode: l("automatic"), thresholdDbfs: k().finite().min(-120).max(-20), holdSec: k().finite().min(0.1).max(10), maximumSec: k().finite().min(0.1).max(120) }).strict()
        ])
      }).strict(),
      encoding: c({
        mp3Bitrate: k().int().min(32e3).max(32e4).optional(),
        oggOpusBitrate: k().int().min(6e3).max(51e4).optional(),
        wav: ce([
          c({ codec: l("pcm-s16"), dither: P(["none", "tpdf"]) }).strict(),
          c({ codec: l("pcm-s24"), dither: P(["none", "tpdf"]) }).strict(),
          c({ codec: l("pcm-f32"), dither: l("none") }).strict()
        ])
      }).strict()
    }).strict()
  ]),
  "host.export.status": St,
  "host.export.cancel": c({ jobId: R().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/) }).strict(),
  "transport.status": St,
  "transport.play": St,
  "transport.pause": St,
  "transport.stop": St,
  "transport.seek": l0,
  "diagnostics.snapshot": St,
  "control.capabilities": fl,
  "control.snapshot": hl,
  "control.preview": Xd,
  "control.commit": Jd,
  "control.requestApproval": Yd,
  "control.history": rl,
  "control.recoveries": nl
}, m0 = Zn["host.import.audio"], f0 = (e, t) => {
  const r = t.slice(t.lastIndexOf(".")).toLowerCase();
  return e === "wav" && r === ".wav" || e === "mp3" && r === ".mp3" || e === "ogg-opus" && r === ".ogg" || e === "flac" && r === ".flac";
}, jn = Zn["host.export.run"].superRefine((e, t) => {
  e.mode !== "mixdown" || e.destination.kind !== "file" || f0(e.format, e.destination.path) || t.addIssue({ code: "custom", message: "Mixdown file extension must match the selected format.", path: ["destination", "path"] });
}), h0 = R().regex(/^[a-f0-9]{64}$/), zo = c({
  token: h0,
  basename: R().min(1).max(256)
}).strict(), bl = c({
  canceled: M(),
  files: T(c({
    ...zo.shape,
    mime: R().min(1).max(128)
  }).strict()).min(1).max(1).optional()
}).strict().superRefine((e, t) => {
  !e.canceled && e.files === void 0 && t.addIssue({ code: "custom", message: "A non-canceled import requires a file capability." });
}), g0 = J("kind", [
  c({ kind: l("capability-file"), ...zo.shape }).strict(),
  c({ kind: l("capability-directory"), ...zo.shape }).strict()
]), y0 = /* @__PURE__ */ new Set([
  "canceled",
  "preflightOnly",
  "destination",
  "mode",
  "format",
  "formats",
  "range",
  "render",
  "encoding",
  "selection",
  "stemMode"
]), b0 = c({
  canceled: l(!1),
  preflightOnly: l(!0).optional(),
  destination: g0
}).passthrough().superRefine((e, t) => {
  for (const s of Object.keys(e))
    y0.has(s) || t.addIssue({ code: "unrecognized_keys", keys: [s], path: [] });
  const { canceled: r, preflightOnly: n, ...o } = e, a = e.destination.kind === "capability-file" ? { kind: "file", path: `/capability/${e.destination.basename}` } : { kind: "directory", path: "/capability" };
  jn.safeParse({ ...o, destination: a }).success || t.addIssue({ code: "custom", message: "Invalid renderer export operation input." });
}), v0 = J("mode", [
  c({ canceled: l(!0), mode: l("mixdown") }).strict(),
  c({ canceled: l(!0), mode: l("stems") }).strict()
]), Pt = ce([
  v0,
  b0
]), $r = c({
  version: Ne,
  code: P(["invalid-request", "unauthorized", "unsupported-version", "unavailable", "cancelled", "deadline-exceeded", "internal"]),
  message: R().min(1).max(512)
}).strict(), To = $r.extend({ version: ht }), k0 = c({
  project: c({ id: R().min(1).max(256), kind: P(["local", "cloud"]) }).nullable(),
  ready: M(),
  transport: P(["playing", "paused", "stopped"]),
  capabilities: c({
    playback: M(),
    diagnostics: M()
  }).strict()
}).strict(), Sr = c({ state: P(["playing", "paused", "stopped"]), playheadSec: at }).strict(), w0 = c({
  audio: c({
    state: R().max(64),
    sampleRate: k().finite().nullable()
  }).strict(),
  recording: c({
    transport: P(["sab", "transferable"]).nullable(),
    capturedFrames: k().int().nonnegative().nullable(),
    droppedFrames: k().int().nonnegative().nullable(),
    deviceLost: M()
  }).strict(),
  counts: c({ tracks: k().int().nonnegative(), clips: k().int().nonnegative() }).strict()
}).strict(), I0 = c({ name: R().min(1).max(256), sizeBytes: k().int().nonnegative().max(8 * 1024 * 1024 * 1024) }).strict(), S0 = c({
  status: P(["created", "queued", "canceled", "failed"]),
  count: k().int().min(0).max(1)
}).strict(), vl = c({
  status: P(["queued", "canceled"]),
  jobId: R().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).optional()
}).strict().refine((e) => e.status === "canceled" || e.jobId !== void 0), Zi = c({
  status: P(["idle", "queued", "running", "completed", "canceled", "failed"]),
  job: c({
    id: R().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
    phase: R().min(1).max(32).optional(),
    sizeBytes: k().int().nonnegative().max(8 * 1024 * 1024 * 1024).optional(),
    outputs: T(I0).max(1024).optional()
  }).strict().optional()
}).strict(), x0 = c({
  version: Ne,
  type: l("request"),
  id: rt,
  operation: Dt,
  input: ut(),
  deadlineMs: k().int().positive().max(Qr).optional()
}).strict().superRefine((e, t) => {
  (e.operation === "host.export.run" ? jn : za(e.operation)).safeParse(e.input).success || t.addIssue({ code: "custom", message: "Invalid operation input.", path: ["input"] });
}), E0 = x0, P0 = c({
  version: Ne,
  type: l("request"),
  id: rt,
  operation: l("lifecycle.prepareToClose"),
  input: St,
  deadlineMs: k().int().positive().max(Qr).optional()
}).strict(), A0 = c({
  version: Ne,
  type: l("request"),
  id: rt,
  operation: Dt.exclude(["control.capabilities", "control.snapshot", "control.preview", "control.commit", "control.requestApproval", "control.history", "control.recoveries"]),
  input: ut(),
  deadlineMs: k().int().positive().max(Qr).optional()
}).strict().superRefine((e, t) => {
  (e.operation === "host.import.audio" ? bl : e.operation === "host.export.run" ? Pt : za(e.operation)).safeParse(e.input).success || t.addIssue({ code: "custom", message: "Invalid renderer operation input.", path: ["input"] });
}), kl = ce([A0, P0]), wl = P([
  "control.capabilities",
  "control.snapshot",
  "control.preview",
  "control.commit",
  "control.requestApproval",
  "control.history",
  "control.recoveries"
]), _0 = c({
  version: Ne,
  type: l("request"),
  id: rt,
  operation: wl,
  input: ut(),
  deadlineMs: k().int().positive().max(Qr).optional(),
  actorSubject: R().regex(/^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
}).strict().superRefine((e, t) => {
  (e.operation === "control.capabilities" ? u0 : e.operation === "control.snapshot" ? p0 : za(e.operation)).safeParse(e.input).success || t.addIssue({ code: "custom", message: "Invalid renderer control operation input.", path: ["input"] });
}), z0 = ce([kl, _0]), Il = c({
  version: Ne,
  type: l("reply"),
  id: rt,
  result: ut().optional(),
  error: ce([$r, Fr]).optional()
}).strict().superRefine((e, t) => {
  e.result === void 0 == (e.error === void 0) && t.addIssue({ code: "custom", message: "Reply requires exactly one result or error." });
}), T0 = c({ version: Ne, type: l("cancel"), id: rt }).strict(), vn = c({
  version: Ne,
  type: l("replyChunk"),
  id: rt,
  operation: Dt,
  index: k().int().nonnegative(),
  total: k().int().positive().max(ml),
  byteLength: k().int().positive().max(Aa),
  sha256: R().regex(/^[a-f0-9]{64}$/),
  payload: R().max(c0).regex(/^[A-Za-z0-9+/]*={0,2}$/)
}).strict().refine((e) => e.index < e.total), Sl = c({ version: Ne, type: l("progress"), id: rt, message: R().max(256) }).strict(), xl = c({
  version: Ne,
  type: l("export-terminal"),
  jobId: R().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  status: P(["success", "canceled", "error"])
}).strict(), Ro = c({ version: Ne, type: l("hello"), secret: R().regex(/^[a-f0-9]{64}$/), client: R().min(1).max(128), actorId: R().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) }).strict(), R0 = c({ version: Ne, type: l("helloAck"), sessionId: R().min(16).max(128), capabilities: T(Dt).max(Dt.options.length) }).strict(), El = c({ version: Ne, type: l("lifecycle"), event: P(["renderer-lost", "closing"]) }).strict(), Pl = J("type", [E0, Il, vn, T0, Sl, xl, Ro, R0, El]), so = {
  ...Zn,
  "control.capabilities": ce([Kd, gl]),
  "control.snapshot": ce([qn, yl])
}, C0 = c({
  version: ht,
  type: l("request"),
  id: rt,
  operation: Dt,
  input: ut(),
  deadlineMs: k().int().positive().max(Qr).optional()
}).strict().superRefine((e, t) => {
  (e.operation === "host.export.run" ? jn : br(e.operation) ? e.operation === "control.capabilities" ? so["control.capabilities"] : e.operation === "control.snapshot" ? so["control.snapshot"] : Jr[e.operation].input : so[e.operation]).safeParse(e.input).success || t.addIssue({ code: "custom", message: "Invalid operation input.", path: ["input"] });
}), M0 = C0, Al = c({
  version: ht,
  type: l("reply"),
  id: rt,
  result: ut().optional(),
  error: ce([
    To,
    Fr
  ]).optional()
}).strict().superRefine((e, t) => {
  e.result === void 0 == (e.error === void 0) && t.addIssue({ code: "custom", message: "Reply requires exactly one result or error." });
}), D0 = c({ version: ht, type: l("cancel"), id: rt }).strict(), Co = c({
  ...vn.shape,
  version: ht
}).strict().refine((e) => e.index < e.total), V0 = Sl.extend({ version: ht }), O0 = xl.extend({ version: ht }), _l = c({
  version: ht,
  type: l("hello"),
  secret: R().regex(/^[a-f0-9]{64}$/),
  client: R().min(1).max(128),
  actorId: R().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  supportedVersions: T(P(Li)).min(1).max(Li.length).refine((e) => new Set(e).size === e.length && e.includes("v2"))
}).strict(), B0 = c({
  version: ht,
  type: l("helloAck"),
  selectedVersion: l(Pe),
  sessionId: R().min(16).max(128),
  capabilities: T(Dt).max(Dt.options.length)
}).strict(), F0 = El.extend({ version: ht }), N0 = J("type", [
  M0,
  Al,
  Co,
  D0,
  V0,
  O0,
  _l,
  B0,
  F0
]), $0 = ce([Pl, N0]), q0 = c({
  version: Ne,
  instanceId: R().regex(/^[a-f0-9]{32}$/),
  pid: k().int().positive(),
  createdAt: k().int().positive(),
  address: R().min(1).max(512),
  secret: R().regex(/^[a-f0-9]{64}$/)
}).strict(), H0 = {
  "host.status": k0,
  "host.import.audio": S0,
  "host.export.run": vl,
  "host.export.status": Zi,
  "host.export.cancel": Zi,
  "transport.status": Sr,
  "transport.play": Sr,
  "transport.pause": Sr,
  "transport.stop": Sr,
  "transport.seek": Sr,
  "diagnostics.snapshot": w0
}, Jr = {
  "control.capabilities": {
    input: fl,
    output: _o
  },
  "control.snapshot": {
    input: hl,
    output: sl
  },
  "control.preview": {
    input: Xd,
    output: Dk
  },
  "control.commit": {
    input: Jd,
    output: Ok
  },
  "control.requestApproval": {
    input: Yd,
    output: Vk
  },
  "control.history": {
    input: rl,
    output: Fk
  },
  "control.recoveries": {
    input: nl,
    output: Nk
  }
}, br = (e) => Object.hasOwn(Jr, e), L0 = Object.keys(Jr).map(
  (e) => wl.parse(e)
), za = (e) => br(e) ? Jr[e].input : Zn[e], U0 = (e, t, r, n = Ge) => {
  if (n === Pe && e === "control.capabilities" && gl.safeParse(r).success)
    return Vv.parse(t);
  if (n === Pe && e === "control.snapshot" && yl.safeParse(r).success)
    return Lk.parse(t);
  const o = br(e) ? Jr[e].output : H0[e];
  if (!o) throw new Error("Unknown desktop operation.");
  return o.parse(t);
}, Z0 = (e, t, r = Ge) => br(e) && Fr.safeParse(t).success ? Fr.parse(t) : r === Pe ? To.parse(t) : $r.parse(t), j0 = (e, t) => ({ version: Ge, code: e, message: t }), zl = (e, t) => ({ version: Pe, code: e, message: t }), K0 = new TextEncoder(), W0 = new TextDecoder("utf-8", { fatal: !0 }), it = 4, qr = (e) => {
  const t = K0.encode(JSON.stringify(e));
  if (t.byteLength > pl) throw new Error("Desktop frame exceeds the size limit.");
  const r = new Uint8Array(t.byteLength + it);
  return new DataView(r.buffer).setUint32(0, t.byteLength), r.set(t, it), r;
}, G0 = (e) => {
  let t = new Uint8Array();
  return (r) => {
    const n = new Uint8Array(t.byteLength + r.byteLength);
    for (n.set(t), n.set(r, t.byteLength), t = n; t.byteLength >= it; ) {
      const o = new DataView(t.buffer, t.byteOffset, it).getUint32(0);
      if (o > pl) throw new Error("Desktop frame exceeds the size limit.");
      if (t.byteLength < o + it) return;
      let a;
      try {
        a = JSON.parse(W0.decode(t.subarray(it, o + it)));
      } catch {
        throw new Error("Desktop frame is not JSON.");
      }
      e($0.parse(a), o + it), t = t.slice(o + it);
    }
  };
}, Q0 = new TextEncoder();
new TextDecoder("utf-8", { fatal: !0 });
const J0 = (e) => _n("sha256").update(e).digest("hex"), X0 = (e, t = Aa) => {
  const r = typeof e == "number" ? e : e.byteLength;
  if (!Number.isSafeInteger(r) || r < 0 || r > t)
    throw new Error("Desktop reply exceeds aggregate size limit.");
  return r;
}, Y0 = (e, t, r, n) => {
  const o = (n === Pe ? Al : Il).parse(r);
  return o.error !== void 0 ? Z0(e, o.error, n) : U0(e, o.result, t, n), o;
}, ew = (e, t, r, n = Ge) => {
  const o = Y0(e, r === void 0 ? {} : t, r ?? t, n), a = Q0.encode(JSON.stringify(o));
  if (X0(a), a.byteLength + it <= Ui) return [o];
  const i = J0(a), s = [];
  let d = 0;
  for (; d < a.byteLength; ) {
    let m = 1, h = Math.min(_a, a.byteLength - d);
    for (; m < h; ) {
      const g = Math.ceil((m + h) / 2), S = (n === Pe ? Co : vn).parse({
        version: n,
        type: "replyChunk",
        id: o.id,
        operation: e,
        index: s.length,
        total: ml,
        byteLength: a.byteLength,
        sha256: i,
        payload: Buffer.from(a.subarray(d, d + g)).toString("base64")
      });
      qr(S).byteLength <= Ui ? m = g : h = g - 1;
    }
    s.push(Buffer.from(a.subarray(d, d + m)).toString("base64")), d += m;
  }
  return s.map((m, h) => (n === Pe ? Co : vn).parse({
    version: n,
    type: "replyChunk",
    id: o.id,
    operation: e,
    index: h,
    total: s.length,
    byteLength: a.byteLength,
    sha256: i,
    payload: m
  }));
}, tw = (e) => {
  let t = !1;
  return async () => {
    if (!t) {
      t = !0;
      try {
        if (await e.prepare()) {
          e.destroy(), await e.finishQuit();
          return;
        }
        await e.confirmDiscard() && (e.destroy(), await e.finishQuit());
      } finally {
        t = !1;
      }
    }
  };
}, rw = 4 * 1024, nw = 4 * 1024, ow = 3e4;
class yt extends Error {
  code;
  constructor(t) {
    super(`Native file helper rejected the operation: ${t}.`), this.name = "NativeFileCapabilityError", this.code = t;
  }
}
const aw = (e) => e === "file-too-large" || e === "commit-indeterminate" || e === "identity-mismatch" || e === "invalid-path" || e === "invalid-request" || e === "io-error" || e === "path-exists" || e === "source-invalid" || e === "target-changed", ji = (e, t) => {
  if (typeof e != "string" || !/^(0|[1-9][0-9]*)$/.test(e))
    throw new Error(`Native file helper returned an invalid ${t}.`);
  return e;
}, Mo = (e, t, r) => ({
  device: ji(e, `${r} device`),
  inode: ji(t, `${r} inode`)
}), Hr = (e, t) => {
  const r = Object.keys(e).sort(), n = [...t].sort();
  return r.length === n.length && r.every((o, a) => o === n[a]);
}, Ta = (e) => {
  let t;
  try {
    t = JSON.parse(e.stdout);
  } catch {
    throw new Error("Native file helper returned invalid JSON.");
  }
  if (typeof t != "object" || t === null || Array.isArray(t))
    throw new Error("Native file helper returned an invalid reply.");
  return t;
}, iw = (e) => {
  switch (e) {
    case "invalid-request":
      return 10;
    case "invalid-path":
      return 11;
    case "identity-mismatch":
      return 12;
    case "path-exists":
      return 13;
    case "target-changed":
      return 14;
    case "source-invalid":
      return 15;
    case "file-too-large":
      return 16;
    case "io-error":
      return 17;
    case "commit-indeterminate":
      return 19;
  }
}, Ra = (e, t) => {
  throw !Hr(e, ["ok", "code"]) || !("ok" in e) || e.ok !== !1 || !("code" in e) ? new Error("Native file helper returned an invalid failure.") : typeof e.code != "string" || !aw(e.code) ? new Error("Native file helper returned an unknown failure.") : t !== iw(e.code) ? new Error("Native file helper returned a mismatched failure code.") : new yt(e.code);
}, Ki = (e) => {
  const t = Ta(e);
  if ("ok" in t && t.ok === !1 && Ra(t, e.exitCode), e.exitCode !== 0) throw new Error("Native file helper exited unsuccessfully.");
  if (!Hr(t, ["ok"]) || !("ok" in t) || t.ok !== !0)
    throw new Error("Native file helper returned an invalid success reply.");
}, sw = (e) => {
  const t = Ta(e);
  if ("ok" in t && t.ok === !1 && Ra(t, e.exitCode), e.exitCode !== 0) throw new Error("Native file helper exited unsuccessfully.");
  if (!Hr(t, ["ok", "dev", "ino"]) || !("ok" in t) || t.ok !== !0)
    throw new Error("Native file helper returned an invalid directory reply.");
  return Mo(
    "dev" in t ? t.dev : void 0,
    "ino" in t ? t.ino : void 0,
    "directory"
  );
}, Wi = (e) => {
  const t = Ta(e);
  if ("ok" in t && t.ok === !1 && Ra(t, e.exitCode), e.exitCode !== 0) throw new Error("Native file helper exited unsuccessfully.");
  if (!Hr(t, ["ok", "parentDev", "parentIno", "basename", "file"]) || !("ok" in t) || t.ok !== !0 || !("basename" in t) || typeof t.basename != "string" || t.basename.length === 0 || t.basename.length > 255 || t.basename === "." || t.basename === ".." || t.basename.includes("/"))
    throw new Error("Native file helper returned an invalid file reply.");
  const r = {
    parent: Mo(
      "parentDev" in t ? t.parentDev : void 0,
      "parentIno" in t ? t.parentIno : void 0,
      "parent"
    ),
    basename: t.basename
  };
  if (!("file" in t) || t.file === null) return r;
  if (typeof t.file != "object" || Array.isArray(t.file) || !Hr(t.file, ["dev", "ino"]))
    throw new Error("Native file helper returned an invalid target identity.");
  return {
    ...r,
    file: Mo(
      "dev" in t.file ? t.file.dev : void 0,
      "ino" in t.file ? t.file.ino : void 0,
      "target"
    )
  };
}, cw = () => {
  const e = [
    ...process.resourcesPath ? [O.join(process.resourcesPath, "file-capability-helper")] : [],
    O.join(import.meta.dirname, ".native", "file-capability-helper"),
    O.join(import.meta.dirname, "..", "..", ".native", "file-capability-helper"),
    O.join(process.cwd(), ".native", "file-capability-helper")
  ];
  return e.find((t) => sr(t)) ?? e[0];
}, xr = (e, t, r, n = ow, o, a = !1) => new Promise((i, s) => {
  try {
    r?.throwIfAborted();
  } catch (C) {
    s(C);
    return;
  }
  const d = Tn(e, t, {
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    stdio: o === void 0 ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", o],
    windowsHide: !0
  });
  if (!d.stdout || !d.stderr) {
    d.kill(), s(a ? new yt("commit-indeterminate") : new Error("Native file helper pipes were unavailable."));
    return;
  }
  const m = d.stdout, h = d.stderr;
  let g = "", S = "", _ = !1, H = !1, q;
  const u = (C) => {
    s(a && H ? new yt("commit-indeterminate") : C);
  }, p = (C) => {
    _ || (_ = !0, q && clearTimeout(q), r?.removeEventListener("abort", A), C());
  }, A = () => {
    d.kill(), p(() => u(r?.reason ?? new Error("Native helper aborted.")));
  };
  d.once("spawn", () => {
    H = !0;
  }), r?.addEventListener("abort", A, { once: !0 }), n !== void 0 && (q = setTimeout(() => {
    d.kill("SIGKILL"), p(() => u(new Error("Native file helper timed out.")));
  }, n)), d.once("error", (C) => p(() => u(C))), m.on("data", (C) => {
    g += C.toString("utf8"), Buffer.byteLength(g) > rw && (d.kill(), p(() => u(new Error("Native file helper reply exceeded its limit."))));
  }), h.on("data", (C) => {
    S += C.toString("utf8"), Buffer.byteLength(S) > nw && (d.kill("SIGKILL"), p(() => u(new Error("Native file helper error output exceeded its limit."))));
  }), d.once("close", (C) => p(() => {
    if (S.length > 0) {
      u(new Error("Native file helper wrote unexpected error output."));
      return;
    }
    if (C === null || C < 0) {
      u(new Error("Native file helper terminated unexpectedly."));
      return;
    }
    i({ stdout: g, exitCode: C });
  }));
}), dw = (e) => {
  const t = cw(), r = process.platform === "darwin" || process.platform === "linux", n = async (o, a, i) => {
    a?.throwIfAborted();
    const s = await xr(t, o, void 0, void 0, i, !0);
    try {
      Ki(s);
    } catch (d) {
      throw d instanceof yt ? d : new yt("commit-indeterminate");
    }
  };
  return {
    available: () => r && sr(t),
    selfTest: async (o) => {
      if (!r || !sr(t)) return !1;
      try {
        return Ki(await xr(t, ["self-test"], o)), !0;
      } catch {
        return !1;
      }
    },
    statDirectory: async (o, a) => sw(await xr(t, ["stat-directory", o], a)),
    statFile: async (o, a) => Wi(await xr(t, ["stat-file", o], a)),
    retainFile: async (o, a) => {
      const i = Wi(await xr(t, ["stat-file", o], a));
      if (!i.file) return i;
      a?.throwIfAborted();
      const s = await iu(
        o,
        Ye.O_RDWR | (Ye.O_NOFOLLOW ?? 0)
      );
      try {
        const d = await s.stat({ bigint: !0 });
        if (!d.isFile() || `${d.dev}` !== i.file.device || `${d.ino}` !== i.file.inode)
          throw new yt("target-changed");
        return { ...i, retained: { ...i.file, handle: s } };
      } catch (d) {
        throw await s.close(), d;
      }
    },
    commitDirectory: async (o) => {
      await n([
        "commit-directory",
        o.rootPath,
        o.root.device,
        o.root.inode,
        o.relativePath,
        o.tempPath
      ], o.signal);
    },
    commitFile: async (o) => {
      await n([
        "commit-file",
        o.parentPath,
        o.parent.device,
        o.parent.inode,
        o.basename,
        o.tempPath
      ], o.signal);
    },
    commitRetainedFile: async (o) => {
      await n([
        "commit-retained-file",
        o.retained.device,
        o.retained.inode,
        o.tempPath
      ], o.signal, o.retained.handle.fd);
    }
  };
}, lw = 14400 * 1e3, uw = 16, pw = 10 * 1024 * 1024, mw = 1024 * 1024, fw = 8 * 1024 * 1024 * 1024, hw = 1024, Tl = /* @__PURE__ */ new Map([
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".webm", "audio/webm"]
]);
class Q extends Error {
  code;
  constructor(t, r) {
    super(r), this.name = "FileCapabilityError", this.code = t;
  }
}
const Gi = {
  name: "Audio",
  extensions: [...Tl.keys()].map((e) => e.slice(1))
}, gw = (e) => ({
  name: e === "ogg-opus" ? "Ogg Opus audio" : `${e.toUpperCase()} audio`,
  extensions: [e === "ogg-opus" ? "ogg" : e]
}), yw = (e, t) => O.extname(t).toLowerCase() === (e === "ogg-opus" ? ".ogg" : `.${e}`), bw = (e, t) => process.platform === "win32" ? e.toLowerCase() === t.toLowerCase() : e === t, co = (e) => e instanceof Error && "code" in e, lo = (e) => {
  throw e instanceof yt ? e.code === "commit-indeterminate" ? new Q("commit-indeterminate", "The native commit reached an indeterminate terminal state.") : e.code === "path-exists" ? new Q("path-exists", "The output path already exists.") : new Q("invalid-path", "The granted output location changed or could not be committed safely.") : e;
}, xt = (e) => {
  throw new Q("invalid-path", e);
}, Qi = () => {
  if (process.platform === "win32")
    throw new Q("invalid-path", "This host cannot safely anchor file capabilities on Windows without no-reparse support.");
}, Er = (e) => {
  (e.length === 0 || e.includes("\0") || !O.isAbsolute(e) || O.normalize(e) !== e) && xt("The path must be absolute, normalized, and NUL-free.");
}, vw = (e) => {
  (e.length === 0 || e.includes("\0") || O.isAbsolute(e) || O.normalize(e) !== e || e === "." || e === ".." || e.startsWith(`..${O.sep}`)) && xt("The output path must be relative, normalized, contained, and NUL-free.");
}, Pr = (e) => {
  const t = Tl.get(O.extname(e).toLowerCase());
  if (!t)
    throw new Q("unsupported-file", "The file extension is not supported.");
  return t;
}, uo = (e) => {
  let t = "";
  for (const r of e) t += r.toString(16).padStart(2, "0");
  return t;
}, kw = ({
  dialog: e,
  fileSystem: t = au,
  now: r = Date.now,
  randomBytes: n = Vr,
  nativeHelper: o,
  nativeOutputEnabled: a = () => !1,
  privateTempDirectory: i
}) => {
  const s = /* @__PURE__ */ new Map(), d = /* @__PURE__ */ new Map(), m = /* @__PURE__ */ new Set();
  let h, g = 0;
  const S = (f) => {
    for (let w = 0; w < 16; w += 1) {
      const y = n(32);
      if (y.byteLength !== 32)
        throw new Error("The random source must return exactly 32 bytes.");
      const x = uo(y);
      if (!f.has(x)) return x;
    }
    throw new Error("The random source repeatedly returned duplicate identifiers.");
  }, _ = async (f) => {
    try {
      await t.unlink(f);
    } catch (w) {
      if (!co(w) || w.code !== "ENOENT") throw w;
    }
  }, H = (f) => {
    d.delete(f.id), s.get(f.capabilityToken)?.writerIds.delete(f.id);
  }, q = async (f) => {
    let w;
    if (!f.closed) {
      f.closed = !0;
      try {
        await f.handle.close();
      } catch (y) {
        w = y;
      }
    }
    if (await _(f.tempPath), w !== void 0) throw w;
  }, u = (f) => {
    if (f.state === "committing")
      return f.commitPromise?.then(() => {
      }) ?? Promise.reject(new Error("The committing writer is missing its commit promise."));
    if (f.state === "aborting")
      return f.abortPromise ?? Promise.reject(new Error("The aborting writer is missing its abort promise."));
    if (f.state === "terminal") return Promise.resolve();
    f.state = "aborting";
    const w = (async () => {
      try {
        await f.operation, await q(f);
      } finally {
        try {
          const y = s.get(f.capabilityToken);
          if (y)
            try {
              await wt(y);
            } finally {
              kr(y);
            }
        } finally {
          f.state = "terminal", H(f);
        }
      }
    })();
    return f.abortPromise = w, w;
  }, p = (f) => {
    if (f.revocationPromise) return f.revocationPromise;
    f.revoked = !0;
    const w = (async () => {
      const y = [...f.writerIds];
      for (const x of y) {
        const D = d.get(x);
        if (D)
          try {
            await u(D);
          } catch {
          }
      }
      try {
        await wt(f);
      } finally {
        s.get(f.token) === f && s.delete(f.token);
      }
    })();
    return f.revocationPromise = w, w;
  }, A = async () => {
    const f = r(), w = [...s.values()].filter((y) => y.expiresAt <= f);
    for (const y of w) await p(y);
  }, C = (f, w) => {
    const y = r();
    if ([...s.values()].filter(
      (ve) => !ve.revoked && ve.expiresAt > y
    ).length + g + w > uw)
      throw new Q("capacity-exceeded", "The active file capability limit was reached.");
    g += w;
    let D = !1, j = () => {
    };
    const ae = new Promise((ve) => {
      j = ve;
    }), ue = {
      scope: f,
      revoked: !1,
      settled: ae,
      assertActive: () => {
        if (ue.revoked)
          throw new Q("invalid-capability", "The capability grant was revoked before it settled.");
      },
      release: () => {
        D || (D = !0, m.delete(ue), g -= w, j());
      }
    };
    return m.add(ue), ue;
  }, L = async (f) => {
    const w = [...m].filter((y) => f(y.scope));
    for (const y of w) y.revoked = !0;
    await Promise.all(w.map((y) => y.settled));
  }, K = (f) => {
    if (f.requestId.length === 0 || !Number.isSafeInteger(f.rendererGeneration) || f.rendererGeneration < 0)
      throw new Q("invalid-scope", "The file capability scope is invalid.");
    return {
      ...f,
      token: S(s),
      expiresAt: r() + lw,
      outputBytes: 0,
      reservedOutputBytes: 0,
      outputFiles: 0,
      reservedWriterSlots: 0,
      writerIds: /* @__PURE__ */ new Set(),
      revoked: !1
    };
  }, Ce = async (f, w) => {
    const y = s.get(w);
    if (!y)
      throw new Q("invalid-capability", "The file capability is not active.");
    if (y.revoked)
      throw await y.revocationPromise, new Q("invalid-capability", "The file capability is not active.");
    if (y.expiresAt <= r())
      throw await p(y), new Q("expired", "The file capability expired.");
    if (y.requestId !== f.requestId || y.rendererGeneration !== f.rendererGeneration)
      throw new Q("invalid-scope", "The file capability does not belong to this request.");
    return y;
  }, qe = async (f) => {
    const [w, y] = await Promise.all([
      t.realpath(f),
      t.realpath(O.dirname(f))
    ]);
    return bw(O.dirname(w), y) || xt("Symbolic links and reparse points are not permitted."), w;
  }, He = async (f) => {
    Qi(), Er(f);
    const w = Pr(f), y = await t.lstat(f), x = await t.stat(f);
    if (y.isSymbolicLink() || !y.isFile() || !x.isFile())
      throw new Q("unsupported-file", "The selected path is not a regular file.");
    if (await qe(f), x.size > pw)
      throw new Q("unsupported-file", "The selected file exceeds 10 MiB.");
    return { byteLength: x.size, mime: w, device: x.dev, inode: x.ino };
  }, Jt = async (f) => {
    Qi(), Er(f);
    const w = await t.lstat(f), y = await t.stat(f);
    return (w.isSymbolicLink() || !w.isDirectory() || !y.isDirectory()) && xt("The selected path is not a real directory."), qe(f);
  }, Qe = () => {
    if (o && a() && o.available())
      return o;
    throw new Q("invalid-path", "Secure native output capabilities are unavailable on this host.");
  }, Be = async (f, w) => {
    const y = Qe();
    try {
      const x = w ? await y.retainFile(f) : await y.statFile(f);
      if (x.file && !w)
        throw new Q("path-exists", "The output path already exists.");
      return x.file && !x.retained && xt("The selected overwrite target could not be retained securely."), x;
    } catch (x) {
      return !(x instanceof yt) && !(x instanceof Q) && xt("The selected output could not be retained securely."), lo(x);
    }
  }, oe = async (f) => {
    const w = Qe();
    try {
      return await w.statDirectory(f);
    } catch (y) {
      return lo(y);
    }
  }, wt = async (f) => {
    f.kind !== "write" || !f.retainedOpen || !f.outputGrant.retained || (f.retainedOpen = !1, await f.outputGrant.retained.handle.close());
  }, kr = (f) => {
    f.kind !== "write" || !f.outputGrant.retained || (f.revoked = !0, s.get(f.token) === f && s.delete(f.token));
  }, Je = () => h || (h = (async () => {
    if (i) {
      const f = typeof i == "function" ? i() : i;
      Er(f), await t.mkdir(f, { recursive: !0, mode: 448 });
      const w = await t.open(
        f,
        Ye.O_RDONLY | Ye.O_DIRECTORY | (Ye.O_NOFOLLOW ?? 0)
      );
      try {
        const y = await w.stat();
        (!y.isDirectory() || process.getuid && y.uid !== process.getuid()) && xt("The private temporary output path is not an app-owned directory."), await w.chmod(448);
      } finally {
        await w.close();
      }
      return f;
    }
    for (let f = 0; f < 16; f += 1) {
      const w = O.join(lu(), `daw-browser-${uo(Vr(32))}`);
      try {
        return await t.mkdir(w, { mode: 448 }), w;
      } catch (y) {
        if (!co(y) || y.code !== "EEXIST") throw y;
      }
    }
    throw new Error("Unable to reserve a private temporary output directory.");
  })(), h), I = async () => {
    const f = await Je();
    for (let w = 0; w < 16; w += 1) {
      const y = O.join(f, `.daw-browser-${uo(n(32))}.tmp`);
      try {
        const x = await t.open(
          y,
          Ye.O_CREAT | Ye.O_EXCL | Ye.O_RDWR | (Ye.O_NOFOLLOW ?? 0),
          384
        );
        return { tempPath: y, handle: x };
      } catch (x) {
        if (!co(x) || x.code !== "EEXIST") throw x;
      }
    }
    throw new Error("Unable to reserve a unique temporary output file.");
  }, v = async (f, w) => {
    const y = d.get(w);
    if (!y)
      throw new Q("invalid-capability", "The output writer is not active.");
    const x = await Ce(f, y.capabilityToken);
    return { writer: y, capability: x };
  };
  return {
    async grantReadFile(f, w) {
      const y = C(f, 1);
      try {
        await A();
        const { byteLength: x, mime: D, device: j, inode: ae } = await He(w);
        y.assertActive();
        const ue = {
          ...K(f),
          kind: "read",
          filePath: w,
          byteLength: x,
          mime: D,
          device: j,
          inode: ae
        };
        return s.set(ue.token, ue), { token: ue.token, basename: O.basename(w), byteLength: x, mime: D };
      } finally {
        y.release();
      }
    },
    async grantOutputFile(f, w) {
      const y = C(f, 1);
      try {
        await A(), Er(w);
        const x = Pr(w), D = await Be(w, !1);
        y.assertActive();
        const j = {
          ...K(f),
          kind: "write",
          filePath: w,
          mime: x,
          allowOverwrite: !1,
          outputGrant: D,
          retainedOpen: !1
        };
        return s.set(j.token, j), { token: j.token, basename: O.basename(w), mime: x };
      } finally {
        y.release();
      }
    },
    async grantDirectory(f, w) {
      const y = C(f, 1);
      try {
        await A();
        const x = await Jt(w), D = await oe(x);
        y.assertActive();
        const j = { ...K(f), kind: "directory", directoryPath: x, identity: D };
        return s.set(j.token, j), { token: j.token, basename: O.basename(x) };
      } finally {
        y.release();
      }
    },
    async pickReadFiles(f) {
      const w = C(f, 1);
      try {
        await A();
        const y = await e.showOpenDialog({
          properties: ["openFile"],
          filters: [Gi]
        });
        if (y.canceled || y.filePaths.length === 0) return { canceled: !0 };
        const x = y.filePaths[0], D = [{ filePath: x, ...await He(x) }];
        return w.assertActive(), { canceled: !1, files: D.map(({ filePath: ae, byteLength: ue, mime: ve, device: $e, inode: en }) => {
          const Xn = {
            ...K(f),
            kind: "read",
            filePath: ae,
            byteLength: ue,
            mime: ve,
            device: $e,
            inode: en
          };
          return s.set(Xn.token, Xn), {
            token: Xn.token,
            basename: O.basename(ae),
            byteLength: ue,
            mime: ve
          };
        }) };
      } finally {
        w.release();
      }
    },
    async pickOutputFile(f, w) {
      const y = C(f, 1);
      try {
        await A();
        const x = await e.showSaveDialog({ filters: [w ? gw(w) : Gi] });
        if (x.canceled || x.filePath === void 0) return { canceled: !0 };
        if (w && !yw(w, x.filePath))
          throw new Q("unsupported-file", "The selected output extension does not match the requested format.");
        Er(x.filePath);
        const D = Pr(x.filePath), j = await Be(x.filePath, !0);
        let ae;
        try {
          y.assertActive(), ae = {
            ...K(f),
            kind: "write",
            filePath: x.filePath,
            mime: D,
            allowOverwrite: !0,
            outputGrant: j,
            retainedOpen: j.retained !== void 0
          };
        } catch (ue) {
          throw await j.retained?.handle.close(), ue;
        }
        return s.set(ae.token, ae), {
          canceled: !1,
          file: {
            token: ae.token,
            basename: O.basename(ae.filePath),
            mime: D
          }
        };
      } finally {
        y.release();
      }
    },
    async pickDirectory(f) {
      const w = C(f, 1);
      try {
        await A();
        const y = await e.showOpenDialog({ properties: ["openDirectory"] });
        if (y.canceled || y.filePaths.length === 0) return { canceled: !0 };
        const x = await Jt(y.filePaths[0]), D = await oe(x);
        w.assertActive();
        const j = {
          ...K(f),
          kind: "directory",
          directoryPath: x,
          identity: D
        };
        return s.set(j.token, j), {
          canceled: !1,
          directory: {
            token: j.token,
            basename: O.basename(x)
          }
        };
      } finally {
        w.release();
      }
    },
    async readFile(f, w) {
      const y = await Ce(f, w);
      if (y.kind !== "read")
        throw new Q("invalid-capability", "The capability does not permit reads.");
      const x = await He(y.filePath);
      if (x.byteLength !== y.byteLength || x.mime !== y.mime || x.device !== y.device || x.inode !== y.inode)
        throw new Q("unsupported-file", "The selected file changed after access was granted.");
      const D = process.platform === "win32" ? 0 : Ye.O_NOFOLLOW ?? 0, j = await t.open(y.filePath, Ye.O_RDONLY | D);
      try {
        const ae = await j.stat();
        if (!ae.isFile() || ae.size !== y.byteLength || ae.dev !== y.device || ae.ino !== y.inode)
          throw new Q("unsupported-file", "The selected file changed after access was granted.");
        return await j.readFile();
      } finally {
        await j.close();
      }
    },
    async beginWrite(f, w, y) {
      const x = await Ce(f, w);
      if (x.kind === "read")
        throw new Q("invalid-capability", "The capability does not permit writes.");
      if (x.outputFiles + x.reservedWriterSlots >= (x.kind === "write" ? 1 : hw) || x.writerIds.size + x.reservedWriterSlots >= 1)
        throw new Q("file-count-exceeded", "The output file limit was reached.");
      x.reservedWriterSlots += 1;
      try {
        let D, j;
        if (x.kind === "write")
          y !== void 0 && xt("A fixed output capability does not accept a relative path."), D = x.filePath, j = {
            kind: "file",
            filePath: x.filePath,
            allowOverwrite: x.allowOverwrite,
            grant: x.outputGrant
          };
        else {
          if (y === void 0)
            throw new Q("invalid-path", "A directory output capability requires a relative path.");
          vw(y), D = O.join(x.directoryPath, y), Pr(D), j = {
            kind: "directory",
            rootPath: x.directoryPath,
            root: x.identity,
            relativePath: y
          };
        }
        const { tempPath: ae, handle: ue } = await I();
        if (s.get(x.token) !== x)
          throw await ue.close(), await _(ae), new Q("invalid-capability", "The output capability was revoked during writer setup.");
        const ve = S(d), $e = {
          id: ve,
          capabilityToken: x.token,
          finalPath: D,
          tempPath: ae,
          handle: ue,
          highWaterMark: 0,
          closed: !1,
          poisoned: !1,
          operation: Promise.resolve(),
          state: "open",
          target: j
        };
        return d.set(ve, $e), x.writerIds.add(ve), x.outputFiles += 1, { writerId: ve };
      } finally {
        x.reservedWriterSlots -= 1;
      }
    },
    async writeChunk(f, w, y, x) {
      const { writer: D, capability: j } = await v(f, w);
      if (D.state !== "open" || D.poisoned)
        throw new Q("invalid-capability", "The output writer is not open.");
      if (!Number.isSafeInteger(y) || y < 0 || x.byteLength === 0 || x.byteLength > mw)
        throw D.poisoned = !0, new Q("invalid-chunk", "Output chunks must be non-empty, at most 1 MiB, and write within or at the end of the output.");
      const ae = D.operation.then(async () => {
        if (D.closed || D.poisoned || y > D.highWaterMark)
          throw D.poisoned = !0, new Q("invalid-chunk", "The output writer changed before the chunk could be written.");
        const ue = y + x.byteLength, ve = Math.max(0, ue - D.highWaterMark);
        if (j.outputBytes + j.reservedOutputBytes + ve > fw)
          throw D.poisoned = !0, new Q("output-limit-exceeded", "The aggregate output limit of 8 GiB was reached.");
        j.reservedOutputBytes += ve;
        try {
          let $e = 0;
          for (; $e < x.byteLength; ) {
            const en = await D.handle.write(
              x,
              $e,
              x.byteLength - $e,
              y + $e
            );
            if (en.bytesWritten <= 0) throw new Error("The output file did not accept the chunk.");
            $e += en.bytesWritten;
          }
          return j.outputBytes += ve, D.highWaterMark = Math.max(D.highWaterMark, ue), ue;
        } catch ($e) {
          throw D.poisoned = !0, $e;
        } finally {
          j.reservedOutputBytes -= ve;
        }
      });
      return D.operation = ae.then(() => {
      }, () => {
      }), { nextOffset: await ae };
    },
    async commitWrite(f, w) {
      const { writer: y } = await v(f, w);
      if (y.state !== "open" || y.closed || y.poisoned)
        throw new Q("invalid-capability", "The output writer is already closed.");
      y.state = "committing";
      const x = (async () => {
        try {
          if (await y.operation, y.poisoned)
            throw new Q("invalid-capability", "The output writer is poisoned and cannot be committed.");
          await y.handle.sync(), await y.handle.close(), y.closed = !0;
          const D = Qe();
          return y.target.kind === "directory" ? await D.commitDirectory({
            rootPath: y.target.rootPath,
            root: y.target.root,
            relativePath: y.target.relativePath,
            tempPath: y.tempPath
          }) : y.target.allowOverwrite && y.target.grant.retained ? await D.commitRetainedFile({
            retained: y.target.grant.retained,
            tempPath: y.tempPath
          }) : await D.commitFile({
            parentPath: O.dirname(y.target.filePath),
            parent: y.target.grant.parent,
            basename: y.target.grant.basename,
            tempPath: y.tempPath
          }), await _(y.tempPath), {
            basename: O.basename(y.finalPath),
            byteLength: y.highWaterMark,
            mime: Pr(y.finalPath)
          };
        } catch (D) {
          try {
            await q(y);
          } catch {
          }
          throw D instanceof yt && lo(D), D;
        } finally {
          try {
            const D = s.get(y.capabilityToken);
            if (D)
              try {
                await wt(D);
              } finally {
                kr(D);
              }
          } finally {
            y.state = "terminal", H(y);
          }
        }
      })();
      return y.commitPromise = x, x;
    },
    async abortWrite(f, w) {
      const { writer: y } = await v(f, w);
      await u(y);
    },
    async revoke(f) {
      const w = s.get(f);
      w && await p(w);
    },
    async revokeRendererGeneration(f) {
      const w = L(
        (x) => x.rendererGeneration === f
      ), y = [...s.values()].filter(
        (x) => x.rendererGeneration === f
      );
      for (const x of y) await p(x);
      await w;
    },
    async revokeRequest(f) {
      const w = L(
        (x) => x.requestId === f.requestId && x.rendererGeneration === f.rendererGeneration
      ), y = [...s.values()].filter(
        (x) => x.requestId === f.requestId && x.rendererGeneration === f.rendererGeneration
      );
      for (const x of y) await p(x);
      await w;
    },
    async revokeAll() {
      const f = L(() => !0), w = [...s.values()];
      for (const y of w) await p(y);
      await f;
    },
    activeCapabilityCount() {
      return [...s.values()].filter((f) => !f.revoked).length;
    }
  };
}, ww = () => {
  const e = /* @__PURE__ */ new Map(), t = /* @__PURE__ */ new Map();
  return {
    create(r) {
      const n = zn();
      return e.set(r, n), t.set(n, r), n;
    },
    getInternal(r) {
      return e.get(r);
    },
    getExternal(r) {
      return t.get(r);
    },
    removeExternal(r) {
      const n = e.get(r);
      if (n)
        return e.delete(r), t.delete(n), n;
    },
    internalIds() {
      return e.values();
    },
    clear() {
      e.clear(), t.clear();
    }
  };
}, Iw = () => {
  const e = /* @__PURE__ */ new Set();
  return {
    add(t) {
      e.add(t);
    },
    delete(t) {
      e.delete(t);
    },
    abortAll() {
      for (const t of e) t.abort();
      e.clear();
    },
    size: () => e.size
  };
}, Sw = (e) => {
  const t = [
    "host.status",
    "transport.status",
    "transport.play",
    "transport.pause",
    "transport.stop",
    "transport.seek",
    "diagnostics.snapshot",
    ...L0
  ];
  return e ? ["host.import.audio", "host.export.run", "host.export.status", "host.export.cancel", ...t] : t;
}, xw = "http://localhost:3000", Ew = (e) => {
  const t = e ? ` ${xw}` : "";
  return `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: https:${t}; connect-src 'self' https: wss:${t}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
}, kn = 2 * 1024 * 1024 * 1024, wn = 3, Ca = 64, Ma = 4096, Pw = 16, Aw = 1e3, _w = 1e4, zw = 64, Kn = {
  mkdir: yo,
  readdir: xs,
  readFile: Ss,
  realpath: $o,
  rename: su,
  stat: ur,
  writeFile: Is
}, Ji = () => ({
  version: wn,
  directories: [],
  entries: [],
  diagnostics: [],
  scannedAtMs: null
}), Rl = (e) => ({
  ...e,
  classes: [],
  scanHealth: "filesystem-only"
}), Da = (e, t) => e === t || e.startsWith(`${t}${O.sep}`), $t = (e, t, r) => {
  e.length < zw && e.push({ directory: t, message: r });
}, Tw = (e) => O.basename(e, O.extname(e)), Va = async (e, t = Kn) => {
  if (!e || e.length > Ma || !O.isAbsolute(e))
    throw new Error("A configured plug-in directory must be an absolute path.");
  const r = await t.realpath(e);
  if (!(await t.stat(r)).isDirectory())
    throw new Error("A configured plug-in path must be a directory.");
  return r;
}, Rw = async (e, t = Kn) => {
  const r = /* @__PURE__ */ new Set();
  for (const n of e.slice(0, Ca))
    try {
      r.add(await Va(n, t));
    } catch {
      continue;
    }
  return [...r].sort((n, o) => n.localeCompare(o));
}, Cw = async (e, t = Date.now, r = Kn) => {
  const n = [], o = /* @__PURE__ */ new Map();
  for (const a of e) {
    let i;
    try {
      i = await Va(a, r);
    } catch {
      $t(n, a, "The configured directory is unavailable.");
      continue;
    }
    const s = [{ directory: i, depth: 0 }];
    let d = 0, m = 0;
    for (; s.length > 0; ) {
      const h = s.shift();
      if (d >= Aw) {
        $t(n, i, "Directory traversal limit reached.");
        break;
      }
      d += 1;
      let g;
      try {
        g = await r.readdir(h.directory, { withFileTypes: !0 });
      } catch {
        $t(n, h.directory, "The directory could not be read.");
        continue;
      }
      for (const S of g) {
        if (m >= _w) {
          $t(n, i, "Directory entry traversal limit reached."), s.length = 0;
          break;
        }
        if (m += 1, S.isSymbolicLink() || !S.isDirectory()) continue;
        const _ = O.join(h.directory, S.name);
        if (O.extname(S.name).toLowerCase() === ".vst3") {
          try {
            const H = await Oa(_);
            if (!Da(H, i)) {
              $t(n, _, "The VST3 bundle resolves outside its configured directory.");
              continue;
            }
            o.has(H) || o.set(H, Rl({
              bundlePath: H,
              displayName: Tw(H),
              configuredDirectory: i,
              discoveredAtMs: t(),
              architecture: "unknown",
              hostingStatus: "unavailable",
              unavailableReason: "VST3 discovery is available, but native VST3 audio hosting is not active."
            }));
          } catch {
            $t(n, _, "The VST3 bundle is unavailable.");
          }
          continue;
        }
        if (h.depth >= Pw) {
          $t(n, h.directory, "Directory traversal depth limit reached.");
          continue;
        }
        s.push({ directory: _, depth: h.depth + 1 });
      }
    }
  }
  return {
    entries: [...o.values()].sort((a, i) => a.bundlePath.localeCompare(i.bundlePath)),
    diagnostics: n,
    scannedAtMs: t()
  };
}, Mw = (e) => Array.isArray(e) && e.every((t) => typeof t == "string"), Dw = (e) => typeof e != "object" || e === null ? !1 : "classId" in e && typeof e.classId == "string" && e.classId.length > 0 && e.classId.length <= 256 && "vendor" in e && typeof e.vendor == "string" && e.vendor.length > 0 && e.vendor.length <= 256 && "name" in e && typeof e.name == "string" && e.name.length > 0 && e.name.length <= 256 && "version" in e && typeof e.version == "string" && e.version.length > 0 && e.version.length <= 256 && "role" in e && (e.role === "effect" || e.role === "instrument") && "source" in e && (e.source === "moduleinfo" || e.source === "factory") && (!("sdkVersion" in e) || e.sdkVersion === void 0 || typeof e.sdkVersion == "string"), Vw = (e) => {
  if (typeof e != "object" || e === null) return !1;
  const t = e;
  return "bundlePath" in t && typeof t.bundlePath == "string" && O.isAbsolute(t.bundlePath) && O.extname(t.bundlePath).toLowerCase() === ".vst3" && "displayName" in t && typeof t.displayName == "string" && "configuredDirectory" in t && typeof t.configuredDirectory == "string" && O.isAbsolute(t.configuredDirectory) && "discoveredAtMs" in t && typeof t.discoveredAtMs == "number" && "architecture" in t && t.architecture === "unknown" && "hostingStatus" in t && t.hostingStatus === "unavailable" && "unavailableReason" in t && t.unavailableReason === "VST3 discovery is available, but native VST3 audio hosting is not active." && "classes" in t && Array.isArray(t.classes) && t.classes.length <= 1024 && t.classes.every(Dw) && "scanHealth" in t && (t.scanHealth === "filesystem-only" || t.scanHealth === "scanned" || t.scanHealth === "scan-failed") && (!("scannerVersion" in t) || t.scannerVersion === void 0 || typeof t.scannerVersion == "string") && (!("sdkVersion" in t) || t.sdkVersion === void 0 || typeof t.sdkVersion == "string") && (!("binaryFingerprint" in t) || t.binaryFingerprint === void 0 || typeof t.binaryFingerprint == "string" && /^[a-f0-9]{64}$/.test(t.binaryFingerprint)) && (!("launchEligibility" in t) || t.launchEligibility === void 0 || Ow(t.launchEligibility, t));
}, Ow = (e, t) => {
  if (typeof e != "object" || e === null || typeof t != "object" || t === null) return !1;
  const r = e;
  return !("bundlePath" in t) || typeof t.bundlePath != "string" || !("binaryFingerprint" in t) || typeof t.binaryFingerprint != "string" ? !1 : "canonicalBundlePath" in r && r.canonicalBundlePath === t.bundlePath && "canonicalExecutablePath" in r && typeof r.canonicalExecutablePath == "string" && O.isAbsolute(r.canonicalExecutablePath) && Da(r.canonicalExecutablePath, t.bundlePath) && "binaryFingerprint" in r && typeof r.binaryFingerprint == "string" && /^[a-f0-9]{64}$/.test(r.binaryFingerprint) && r.binaryFingerprint === t.binaryFingerprint && "bundleFingerprint" in r && typeof r.bundleFingerprint == "string" && /^[a-f0-9]{64}$/.test(r.bundleFingerprint) && "architecture" in r && r.architecture === "arm64" && "codeSignVerifiedAtMs" in r && typeof r.codeSignVerifiedAtMs == "number" && Number.isSafeInteger(r.codeSignVerifiedAtMs) && r.codeSignVerifiedAtMs >= 0 && "quarantinePresent" in r && r.quarantinePresent === !1 && "scannerProtocolVersion" in r && r.scannerProtocolVersion === 2;
}, Bw = (e) => typeof e != "object" || e === null ? !1 : "directory" in e && typeof e.directory == "string" && "message" in e && typeof e.message == "string", Fw = (e) => {
  if (typeof e != "object" || e === null) return;
  const t = "directories" in e && Mw(e.directories) ? e.directories : void 0;
  if (!(!("version" in e) || e.version !== 1 && e.version !== 2 && e.version !== wn || t === void 0 || t.length > Ca || !t.every((r) => O.isAbsolute(r) && r.length <= Ma) || !("entries" in e) || !Array.isArray(e.entries) || !(e.version === 1 ? e.entries.every(Nw) : e.entries.every(Vw)) || !e.entries.every((r) => t.includes(r.configuredDirectory) && Da(r.bundlePath, r.configuredDirectory)) || !("diagnostics" in e) || !Array.isArray(e.diagnostics) || !e.diagnostics.every(Bw) || !("scannedAtMs" in e) || e.scannedAtMs !== null && typeof e.scannedAtMs != "number"))
    return {
      version: wn,
      directories: t,
      entries: e.version === 1 ? e.entries.map((r) => Rl(r)) : e.entries.map((r) => ({
        ...r,
        ...e.version === 2 ? { launchEligibility: void 0 } : {}
      })),
      diagnostics: e.diagnostics,
      scannedAtMs: e.scannedAtMs
    };
}, Nw = (e) => {
  if (typeof e != "object" || e === null) return !1;
  const t = e;
  return "bundlePath" in t && typeof t.bundlePath == "string" && O.isAbsolute(t.bundlePath) && "displayName" in t && typeof t.displayName == "string" && "configuredDirectory" in t && typeof t.configuredDirectory == "string" && O.isAbsolute(t.configuredDirectory) && "discoveredAtMs" in t && typeof t.discoveredAtMs == "number" && "architecture" in t && t.architecture === "unknown" && "hostingStatus" in t && t.hostingStatus === "unavailable" && "unavailableReason" in t && t.unavailableReason === "VST3 discovery is available, but native VST3 audio hosting is not active.";
}, $w = (e) => {
  const t = e.fileSystem ?? Kn, r = e.now ?? Date.now;
  let n;
  const o = async () => {
    if (n) return n;
    try {
      const h = await t.readFile(e.filePath, "utf8");
      n = Fw(JSON.parse(h)) ?? Ji();
    } catch {
      n = Ji();
    }
    return n;
  }, a = async () => (n = void 0, o()), i = async (h) => {
    const g = O.dirname(e.filePath), S = `${e.filePath}.tmp`;
    return await t.mkdir(g, { recursive: !0 }), await t.writeFile(S, JSON.stringify(h), "utf8"), await t.rename(S, e.filePath), n = h, h;
  };
  return { addDirectory: async (h) => {
    const g = await o(), S = await Va(h, t);
    if (!g.directories.includes(S) && g.directories.length >= Ca)
      throw new Error("Too many configured plug-in directories.");
    const _ = await Rw([...g.directories, S], t);
    return i({ ...g, directories: _ });
  }, load: o, reload: a, removeDirectory: async (h) => {
    const g = await o();
    if (!O.isAbsolute(h) || h.length > Ma)
      throw new Error("A configured plug-in directory must be an absolute path.");
    const S = g.directories.filter((_) => _ !== h);
    return i({
      ...g,
      directories: S,
      entries: g.entries.filter((_) => _.configuredDirectory !== h)
    });
  }, scan: async (h) => {
    const S = (await o()).directories, _ = await Cw(S, r, t), H = h ? await Promise.all(_.entries.map(async (q) => {
      try {
        return { ...q, ...await h(q) };
      } catch {
        return { ...q, scanHealth: "scan-failed" };
      }
    })) : _.entries;
    return i({ version: wn, directories: S, ..._, entries: H });
  } };
}, Oa = async (e) => {
  const t = await $o(e);
  if (O.extname(t).toLowerCase() !== ".vst3")
    throw new Error("Only VST3 bundle paths are accepted.");
  if (!(await ur(t)).isDirectory())
    throw new Error("VST3 scanner paths must be bundle directories.");
  return t;
}, qw = { stat: ur, createReadStream: Ho }, Hw = async (e, t = qw) => {
  const r = await t.stat(e);
  if (!r.isFile() || r.size > kn)
    throw new Error("Plugin binary is unavailable or exceeds the scanner size limit.");
  const n = _n("sha256");
  let o = 0;
  for await (const a of t.createReadStream(e)) {
    if (!(a instanceof Uint8Array)) throw new Error("Plugin binary stream returned an invalid chunk.");
    if (o += a.byteLength, o > kn)
      throw new Error("Plugin binary is unavailable or exceeds the scanner size limit.");
    n.update(a);
  }
  return n.digest("hex");
}, Lw = async (e) => {
  const t = await Oa(e), r = _n("sha256");
  let n = 0;
  const o = async (i, s) => {
    const d = await ur(i);
    if (!d.isFile() || d.size > kn - n)
      throw new Error("Plugin bundle is unavailable or exceeds the scanner size limit.");
    r.update(`file:${s}:${d.size}
`);
    for await (const m of Ho(i)) {
      if (n += m.byteLength, n > kn)
        throw new Error("Plugin bundle is unavailable or exceeds the scanner size limit.");
      r.update(m);
    }
  }, a = async (i, s) => {
    const d = await xs(i, { withFileTypes: !0 });
    for (const m of d.sort((h, g) => h.name.localeCompare(g.name))) {
      if (m.isSymbolicLink()) throw new Error("Plugin bundles containing symbolic links cannot be scanned.");
      const h = s ? O.join(s, m.name) : m.name, g = O.join(i, m.name);
      m.isDirectory() ? (r.update(`directory:${h}
`), await a(g, h)) : await o(g, h);
    }
  };
  return await a(t, ""), r.digest("hex");
}, Uw = { minimum: 1, maximum: 2 }, vr = 1048576, Ba = 2, Xi = 512 * 1024, Cl = 8, Wt = 64, Lr = 8192, Wn = 2048, Xr = "daw-vst3-worker", Ml = "1", Zw = 1, Fa = 1, Na = Ba, $a = 1, Yr = R().min(1).max(96).regex(/^[A-Za-z0-9._-]+$/), Ie = R().uuid(), bt = R().regex(/^[a-f0-9]{64}$/), jw = R().min(1).max(20).regex(/^[1-9][0-9]*$/).refine((e) => BigInt(e) <= 0xffffffffffffffffn, "Native graph node ID exceeds uint64."), Kt = k().finite(), Ut = R().min(1).max(256), In = R().min(1).max(4096), qa = c({
  minimum: k().int().positive(),
  maximum: k().int().positive()
}).strict().refine((e) => e.minimum <= e.maximum), Ha = c({
  format: l("vst3"),
  classId: R().min(1).max(128),
  vendor: R().min(1).max(256),
  name: R().min(1).max(256),
  version: R().min(1).max(128),
  architecture: l("arm64"),
  /* Discovery paths are local catalog data. Persisted/project identities omit
   * them and are resolved by a trusted native catalog at launch time. */
  discoveredPath: R().min(1).max(4096).optional(),
  binaryFingerprint: bt
}).strict(), tt = c({
  name: R().min(1).max(128),
  channels: k().int().min(0).max(64),
  enabled: M()
}).strict(), Gn = c({
  id: k().int().nonnegative().max(2147483647),
  title: R().min(1).max(256),
  unit: R().max(64),
  minimum: Kt,
  maximum: Kt,
  defaultValue: Kt,
  stepCount: k().int().nonnegative().max(1e6),
  readOnly: M(),
  hidden: M()
}).strict().superRefine((e, t) => {
  e.minimum > e.maximum && t.addIssue({ code: "custom", message: "Parameter minimum exceeds maximum." }), (e.defaultValue < e.minimum || e.defaultValue > e.maximum) && t.addIssue({ code: "custom", message: "Parameter default is outside its range." });
}), Kw = c({
  identity: Ha,
  role: P(["effect", "instrument"]),
  audioInputs: T(tt).max(32),
  audioOutputs: T(tt).min(1).max(32),
  sidechainInputs: T(tt).max(16),
  parameters: T(Gn).max(16384).refine((e) => new Set(e.map((t) => t.id)).size === e.length, "Parameter IDs must be unique."),
  latencyFrames: k().int().nonnegative().max(1e7),
  tailFrames: k().int().nonnegative().max(1e8).nullable(),
  supportsBypass: M(),
  supportsEditor: M(),
  supportsState: M()
}).strict(), Ww = c({
  classId: Ut,
  vendor: Ut,
  name: Ut,
  version: Ut,
  role: P(["effect", "instrument"]),
  source: P(["moduleinfo", "factory"]),
  sdkVersion: R().max(128).optional()
}).strict(), Do = c({
  version: l(2),
  compatibility: qa,
  requestId: Yr
}).strict();
Do.extend({
  type: l("scan"),
  bundlePath: In
}).strict();
const Gw = J("type", [
  Do.extend({
    type: l("result"),
    bundlePath: In,
    scannerVersion: l("1"),
    sdkVersion: Ut,
    classes: T(Ww).max(1024)
  }).strict(),
  Do.extend({
    type: l("error"),
    code: P(["invalid-request", "unavailable", "faulted"]),
    message: R().min(1).max(512)
  }).strict()
]), Qw = (e) => {
  if (new TextEncoder().encode(e).byteLength > vr)
    throw new Error("Plugin host control frame exceeds the maximum size.");
  return Gw.parse(JSON.parse(e));
}, Dl = c({
  artifactId: Ie,
  sha256: bt,
  byteLength: k().int().positive().max(512 * 1024 * 1024),
  artifactKind: P(["plugin-state", "plugin-freeze"]),
  ownerId: R().min(1).max(256),
  acl: P(["owner", "project-members"]),
  bucket: P(["local", "r2-plugin-artifacts"]),
  location: R().min(1).max(1024)
}).strict(), Jw = c({
  state: P(["discovered", "ready", "unavailable", "degraded", "faulted", "architecture-mismatch"]),
  reason: R().min(1).max(512).optional(),
  updatedAt: k().int().nonnegative()
}).strict(), Et = c({
  version: l(1),
  compatibility: qa,
  requestId: Yr
}).strict(), Xw = c({
  instanceId: Ie,
  identity: Ha
}).strict();
J("type", [
  Et.extend({ type: l("scan"), paths: T(R().min(1).max(4096)).max(16) }).strict(),
  Et.extend({ type: l("instantiate"), instance: Xw }).strict(),
  Et.extend({ type: l("dispose"), instanceId: Ie }).strict(),
  Et.extend({ type: l("set-parameters"), instanceId: Ie, values: T(c({ id: k().int().nonnegative().max(2147483647), value: Kt }).strict()).min(1).max(512) }).strict(),
  Et.extend({ type: l("editor"), instanceId: Ie, action: P(["open", "close", "focus"]) }).strict(),
  Et.extend({ type: l("state"), instanceId: Ie, action: P(["save", "load"]), metadata: Dl.optional() }).strict().superRefine((e, t) => {
    e.action === "load" && !e.metadata && t.addIssue({ code: "custom", message: "Loading state requires metadata, not state bytes." });
  })
]);
J("type", [
  Et.extend({ type: l("ok"), instanceId: Ie.optional(), manifest: Kw.optional(), state: Dl.optional() }).strict(),
  Et.extend({ type: l("error"), code: P(["invalid-request", "unsupported", "not-found", "timeout", "faulted", "unavailable"]), message: R().min(1).max(512) }).strict()
]);
const Ue = c({
  version: l(Ba),
  compatibility: qa,
  requestId: Yr
}).strict(), Yw = c({
  instanceId: Ie,
  identity: Ha,
  launchEligibility: c({
    canonicalBundlePath: In,
    canonicalExecutablePath: In,
    bundleFingerprint: bt,
    binaryFingerprint: bt,
    architecture: l("arm64"),
    codeSignVerifiedAtMs: k().int().nonnegative(),
    quarantinePresent: l(!1),
    scannerProtocolVersion: l(2)
  }).strict()
}).strict(), eI = c({
  sampleRate: Kt.positive().max(384e3),
  maximumBlockFrames: k().int().positive().max(Lr),
  inputChannels: k().int().min(0).max(Wt),
  outputChannels: k().int().min(1).max(Wt)
}).strict(), tI = c({
  name: R().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  byteLength: k().int().positive().max(128 * 1024 * 1024),
  slotCount: k().int().min(2).max(Cl),
  maximumFrames: k().int().positive().max(Lr),
  inputChannels: k().int().min(0).max(Wt),
  outputChannels: k().int().min(1).max(Wt),
  maximumEventsPerBlock: k().int().min(0).max(Wn)
}).strict(), Vl = c({
  slotCount: k().int().min(2).max(Cl),
  maximumFrames: k().int().positive().max(Lr),
  inputChannels: k().int().positive().max(Wt),
  outputChannels: k().int().positive().max(Wt),
  maximumEventsPerBlock: k().int().nonnegative().max(Wn)
}).strict(), rI = Vl.extend({
  inputChannels: k().int().min(0).max(Wt)
}).strict(), Ol = c({
  id: l(Xr),
  version: l(Ml)
}).strict(), nI = c({
  version: l(Zw),
  artifact: Ol,
  startupProtocolVersion: l(Fa),
  controlProtocolVersion: l(Na),
  transportAbiVersion: l($a),
  architecture: l("arm64"),
  role: P(["effect", "instrument"]),
  inputBuses: T(tt).max(32),
  outputBuses: T(tt).min(1).max(32),
  transport: rI,
  latencyFrames: k().int().nonnegative().max(1e7),
  tailFrames: k().int().nonnegative().max(1e8).nullable(),
  stateRevision: k().int().nonnegative().max(2147483647),
  parameters: T(Gn).max(16384).optional(),
  supportsBypass: M().optional(),
  supportsEditor: M().optional(),
  supportsState: M().optional()
}).strict().superRefine((e, t) => {
  const r = e.inputBuses.filter((o) => o.enabled).reduce((o, a) => o + a.channels, 0), n = e.outputBuses.filter((o) => o.enabled).reduce((o, a) => o + a.channels, 0);
  r !== e.transport.inputChannels && t.addIssue({ code: "custom", path: ["transport", "inputChannels"], message: "Worker transport input channels do not match enabled input buses." }), n !== e.transport.outputChannels && t.addIssue({ code: "custom", path: ["transport", "outputChannels"], message: "Worker transport output channels do not match enabled output buses." });
}), Bl = c({
  version: l(1),
  type: l("hello"),
  instanceId: Ie,
  manifest: nI
}).strict(), oI = (e) => {
  if (new TextEncoder().encode(e).byteLength > vr)
    throw new Error("Native VST3 worker hello exceeds the maximum size.");
  return Bl.parse(JSON.parse(e));
}, Sn = 1, Fl = c({
  artifact: Ol,
  startupProtocolVersion: l(Fa),
  controlProtocolVersion: l(Na),
  transportAbiVersion: l($a),
  architecture: l("arm64")
}).strict();
c({
  version: l(Sn),
  type: l("preflight"),
  requestId: Yr,
  requirements: Fl
}).strict();
const Yi = c({
  version: l(Sn),
  type: l("preflight-result"),
  requestId: Yr,
  requirements: Fl
}).strict();
J("status", [
  Yi.extend({
    status: l("available"),
    hello: Bl
  }).strict(),
  Yi.extend({
    status: l("unavailable"),
    code: P(["worker-unavailable", "worker-timeout", "worker-crashed", "worker-invalid-response"]),
    message: R().min(1).max(512)
  }).strict()
]);
const aI = c({
  version: l(1),
  classId: Ut,
  vendorId: Ut,
  architecture: l("arm64"),
  bundleFingerprint: bt,
  binaryFingerprint: bt,
  scannerCatalogVersion: l(Ba)
}).strict(), iI = c({
  instanceId: Ie,
  reference: aI
}).strict(), sI = P([
  "browser",
  "project-unavailable",
  "untrusted-catalog",
  "stale-catalog",
  "unsupported-role",
  "unsupported-bus",
  "host-unavailable",
  "worker-unavailable",
  "worker-timeout",
  "worker-crashed",
  "worker-invalid-response"
]), cI = c({
  role: l("effect"),
  inputBuses: T(tt).max(32),
  outputBuses: T(tt).min(1).max(32),
  latencyFrames: k().int().nonnegative().max(1e7),
  tailFrames: k().int().nonnegative().max(1e8).nullable(),
  parameters: T(Gn).max(16384),
  supportsBypass: M(),
  supportsEditor: M(),
  supportsState: M()
}).strict();
J("ok", [
  c({
    ok: l(!0),
    manifest: cI
  }).strict(),
  c({
    ok: l(!1),
    code: sI,
    message: R().min(1).max(512)
  }).strict()
]);
const dI = 1, lI = 64, uI = c({
  format: l("vst3"),
  classId: R().min(1).max(128),
  vendorId: R().min(1).max(256),
  architecture: l("arm64"),
  scannerCatalogVersion: l(2)
}).strict(), pI = c({
  instanceId: Ie,
  graphNodeId: R().min(1).max(256),
  nativeGraphNodeId: jw,
  stageIndex: k().int().nonnegative().max(2147483647),
  catalogIdentity: uI,
  bundleFingerprint: bt,
  binaryFingerprint: bt,
  role: P(["effect", "instrument"]),
  inputBuses: T(tt).max(32),
  outputBuses: T(tt).min(1).max(32),
  workerTransport: Vl,
  declaredLatencyFrames: k().int().nonnegative().max(1e7),
  declaredTailFrames: k().int().nonnegative().max(1e8).nullable(),
  bypassed: M(),
  stateRevision: k().int().nonnegative().max(2147483647),
  parameters: T(Gn).max(16384).optional(),
  parameterOverrides: rc(
    R().regex(/^\d+$/),
    Kt.refine((e) => e >= 0 && e <= 1)
  ).optional()
}).strict(), mI = c({
  version: l(dI),
  attachments: T(pI).max(lI)
}).strict().superRefine((e, t) => {
  const r = /* @__PURE__ */ new Set(), n = /* @__PURE__ */ new Set(), o = /* @__PURE__ */ new Set();
  for (const [a, i] of e.attachments.entries())
    r.has(i.instanceId) && t.addIssue({
      code: "custom",
      path: ["attachments", a, "instanceId"],
      message: "External attachment instance IDs must be unique."
    }), r.add(i.instanceId), n.has(i.graphNodeId) && t.addIssue({
      code: "custom",
      path: ["attachments", a, "graphNodeId"],
      message: "The native graph protocol supports one external attachment per graph node."
    }), n.add(i.graphNodeId), o.has(i.nativeGraphNodeId) && t.addIssue({
      code: "custom",
      path: ["attachments", a, "nativeGraphNodeId"],
      message: "Native graph node IDs must be unique."
    }), o.add(i.nativeGraphNodeId);
}), fI = (e) => {
  if (new TextEncoder().encode(e).byteLength > vr)
    throw new Error("Native external attachment plan exceeds the maximum size.");
  return mI.parse(JSON.parse(e));
}, hI = c({
  byteLength: k().int().nonnegative().max(Xi),
  sha256: bt,
  bytesBase64: R().max(Math.ceil(Xi / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
}).strict().superRefine((e, t) => {
  const r = e.bytesBase64.endsWith("==") ? 2 : e.bytesBase64.endsWith("=") ? 1 : 0;
  e.bytesBase64.length / 4 * 3 - r !== e.byteLength && t.addIssue({ code: "custom", message: "State byte length does not match base64 payload." });
}), gI = J("kind", [
  c({ kind: l("parameter"), id: k().int().nonnegative().max(2147483647), value: Kt, sampleOffset: k().int().nonnegative().max(Lr - 1) }).strict(),
  c({ kind: l("midi"), data: tc([k().int().min(0).max(255), k().int().min(0).max(255), k().int().min(0).max(255)]), sampleOffset: k().int().nonnegative().max(Lr - 1) }).strict()
]);
J("type", [
  Ue.extend({ type: l("lifecycle"), action: P(["hello", "shutdown", "restart"]) }).strict(),
  Ue.extend({ type: l("instantiate"), instance: Yw }).strict(),
  Ue.extend({ type: l("setup"), instanceId: Ie, setup: eI }).strict(),
  Ue.extend({ type: l("transport-negotiate"), instanceId: Ie, transport: tI }).strict(),
  Ue.extend({ type: l("state-transfer"), instanceId: Ie, action: P(["get", "set"]), state: hI.optional() }).strict().superRefine((e, t) => {
    e.action === "set" && !e.state && t.addIssue({ code: "custom", message: "Setting worker state requires state bytes." });
  }),
  Ue.extend({ type: l("events"), instanceId: Ie, events: T(gI).max(Wn) }).strict()
]);
J("type", [
  Ue.extend({ type: l("ready"), instanceId: Ie.optional() }).strict(),
  Ue.extend({ type: l("restart"), instanceId: Ie, reason: R().min(1).max(512) }).strict(),
  Ue.extend({ type: l("latency"), instanceId: Ie, frames: k().int().nonnegative().max(1e7) }).strict(),
  Ue.extend({ type: l("buses"), instanceId: Ie, inputs: T(tt).max(32), outputs: T(tt).max(32) }).strict(),
  Ue.extend({ type: l("health"), instanceId: Ie, health: Jw }).strict(),
  Ue.extend({ type: l("fault"), instanceId: Ie.optional(), code: P(["invalid-request", "transport", "timeout", "launch", "state", "faulted"]), message: R().min(1).max(512) }).strict()
]);
const po = pu(uu), yI = 1e4, bI = (e, t) => e === t || e.startsWith(`${t}${O.sep}`), vI = async (e) => {
  const t = O.join(e, "Contents", "MacOS", O.basename(e, ".vst3"));
  if (!(await ur(t)).isFile()) throw new Error("The VST3 bundle executable is unavailable.");
  return t;
}, kI = (e, t, r) => t ? O.join(e, "daw-vst3-scanner") : r, wI = (e) => {
  if (e.byteLength < 4) throw new Error("The scanner response was incomplete.");
  const t = e.readUInt32BE(0);
  if (t === 0 || t > vr || t !== e.byteLength - 4)
    throw new Error("The scanner response exceeded the frame limit.");
  return e.subarray(4).toString("utf8");
}, II = (e) => {
  const t = Buffer.from(e, "utf8");
  if (t.byteLength === 0 || t.byteLength > vr) throw new Error("The scanner request exceeded the frame limit.");
  const r = Buffer.allocUnsafe(t.byteLength + 4);
  return r.writeUInt32BE(t.byteLength, 0), t.copy(r, 4), r;
}, SI = async (e, t) => {
  const r = await Oa(e);
  if (!(await Promise.all(t.map((i) => $o(i, "utf8")))).some((i) => bI(r, i)))
    throw new Error("The VST3 bundle is outside configured directories.");
  const o = await vI(r);
  try {
    throw await po("xattr", ["-p", "com.apple.quarantine", o]), new Error("Quarantined VST3 binaries cannot be scanned.");
  } catch (i) {
    if (i instanceof Error && i.message === "Quarantined VST3 binaries cannot be scanned.") throw i;
  }
  try {
    await po("codesign", ["--verify", "--strict", o]);
  } catch {
    throw new Error("Unsigned VST3 binaries cannot be scanned.");
  }
  let a;
  try {
    ({ stdout: a } = await po("lipo", ["-archs", o]));
  } catch {
    throw new Error("The VST3 binary architecture could not be verified.");
  }
  if (!a.split(/\s+/).includes("arm64"))
    throw new Error("Only arm64 VST3 binaries can be scanned.");
  return { bundlePath: r, binaryPath: o, codeSignVerifiedAtMs: Date.now() };
}, xI = async (e, t) => new Promise((r, n) => {
  const o = Tn(e, [], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "ignore"]
  }), a = [];
  let i = 0;
  const s = setTimeout(() => {
    o.kill("SIGKILL"), n(new Error("The VST3 scanner timed out."));
  }, yI);
  o.stdout.on("data", (d) => {
    if (i += d.byteLength, i > vr + 4) {
      o.kill("SIGKILL"), n(new Error("The VST3 scanner response exceeded the frame limit."));
      return;
    }
    a.push(d);
  }), o.once("error", n), o.once("close", (d) => {
    if (clearTimeout(s), d !== 0 && a.length === 0) {
      n(new Error("The VST3 scanner failed."));
      return;
    }
    try {
      r(wI(Buffer.concat(a)));
    } catch (m) {
      n(m);
    }
  }), o.stdin.end(II(t));
}), EI = (e) => e.map((t) => ({
  classId: t.classId,
  vendor: t.vendor,
  name: t.name,
  version: t.version,
  role: t.role,
  source: t.source,
  ...t.sdkVersion === void 0 ? {} : { sdkVersion: t.sdkVersion }
})), PI = (e) => ({
  scan: async (t, r) => {
    if (e.platform !== "darwin" || e.arch !== "arm64" || !e.scannerPath) return {};
    await qo(e.scannerPath);
    const n = await SI(t.bundlePath, r), o = zn(), a = Qw(await xI(e.scannerPath, JSON.stringify({
      version: 2,
      compatibility: Uw,
      requestId: o,
      type: "scan",
      bundlePath: n.bundlePath
    })));
    if (a.requestId !== o || a.type === "error" || a.bundlePath !== n.bundlePath)
      throw new Error("The VST3 scanner returned an invalid result.");
    const i = await Hw(n.binaryPath), s = {
      canonicalBundlePath: n.bundlePath,
      canonicalExecutablePath: n.binaryPath,
      bundleFingerprint: await Lw(n.bundlePath),
      binaryFingerprint: i,
      architecture: "arm64",
      codeSignVerifiedAtMs: n.codeSignVerifiedAtMs,
      quarantinePresent: !1,
      scannerProtocolVersion: 2
    };
    return {
      classes: EI(a.classes),
      scanHealth: "scanned",
      scannerVersion: a.scannerVersion,
      sdkVersion: a.sdkVersion,
      binaryFingerprint: i,
      launchEligibility: s
    };
  }
}), cn = (e) => ({
  ...e,
  entries: e.entries.map(({ bundlePath: t, configuredDirectory: r, launchEligibility: n, ...o }) => ({
    ...o,
    ...n === void 0 ? {} : {
      catalogReference: {
        version: 1,
        architecture: n.architecture,
        bundleFingerprint: n.bundleFingerprint,
        binaryFingerprint: n.binaryFingerprint,
        scannerCatalogVersion: n.scannerProtocolVersion
      }
    }
  }))
}), Nl = (e, t) => {
  if (t.version !== 1 || t.architecture !== "arm64") return;
  const r = e.entries.find((a) => a.scanHealth === "scanned" && a.binaryFingerprint === t.binaryFingerprint && a.launchEligibility?.bundleFingerprint === t.bundleFingerprint && a.launchEligibility.scannerProtocolVersion === t.scannerCatalogVersion), n = r?.classes.find((a) => a.classId === t.classId && a.vendor === t.vendorId), o = r?.launchEligibility;
  if (!(!o || !n || o.architecture !== "arm64" || o.quarantinePresent || o.binaryFingerprint !== t.binaryFingerprint || o.bundleFingerprint !== t.bundleFingerprint || o.scannerProtocolVersion !== t.scannerCatalogVersion))
    return {
      classId: t.classId,
      vendorId: t.vendorId,
      role: n.role,
      canonicalBundlePath: o.canonicalBundlePath,
      canonicalExecutablePath: o.canonicalExecutablePath,
      bundleFingerprint: o.bundleFingerprint,
      binaryFingerprint: o.binaryFingerprint,
      scannerProtocolVersion: o.scannerProtocolVersion
    };
}, $l = 16 * 1024, AI = 5e3, es = {
  artifact: {
    id: Xr,
    version: Ml
  },
  startupProtocolVersion: Fa,
  controlProtocolVersion: Na,
  transportAbiVersion: $a,
  architecture: "arm64"
}, _I = (e, t, r) => t ? O.join(e, Xr) : r, zI = (e) => {
  if (e.byteLength < 4) throw new Error("The native VST3 worker response was incomplete.");
  const t = e.readUInt32BE(0);
  if (t === 0 || t > $l || e.byteLength !== t + 4)
    throw new Error("The native VST3 worker response exceeded the frame limit.");
  return oI(e.subarray(4).toString("utf8"));
}, ql = async (e) => {
  const t = zn(), r = (a, i) => ({
    version: Sn,
    type: "preflight-result",
    requestId: t,
    status: "unavailable",
    code: a,
    message: i,
    requirements: es
  });
  try {
    await (e.accessWorker ?? qo)(e.workerPath);
  } catch {
    return r("worker-unavailable", "The packaged native VST3 worker is unavailable.");
  }
  if (!Number.isFinite(e.sampleRateHz) || e.sampleRateHz <= 0 || e.sampleRateHz > 384e3)
    return r("worker-unavailable", "The native VST3 worker preflight sample rate is invalid.");
  const n = e.attachment, o = [
    "--preflight",
    "--instance-id",
    n.instanceId,
    "--bundle-path",
    n.canonicalBundlePath,
    "--executable-path",
    n.canonicalExecutablePath,
    "--bundle-fingerprint",
    n.bundleFingerprint,
    "--binary-fingerprint",
    n.binaryFingerprint,
    "--class-id",
    n.classId,
    "--sample-rate",
    String(e.sampleRateHz),
    "--maximum-frames",
    String(n.workerTransport.maximumFrames),
    "--input-channels",
    String(n.workerTransport.inputChannels),
    "--output-channels",
    String(n.workerTransport.outputChannels),
    "--slot-count",
    String(n.workerTransport.slotCount),
    "--maximum-events",
    String(n.workerTransport.maximumEventsPerBlock),
    "--state-revision",
    String(n.stateRevision)
  ];
  return new Promise((a) => {
    const i = e.spawnWorker ?? ((_, H) => Tn(_, [...H], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"]
    }));
    let s;
    try {
      s = i(e.workerPath, o);
    } catch {
      a(r("worker-unavailable", "The native VST3 worker could not start."));
      return;
    }
    s.stdin.end(), s.stderr.resume();
    const d = [];
    let m = 0, h = !1;
    const g = (_) => {
      h || (h = !0, clearTimeout(S), a(_));
    }, S = setTimeout(() => {
      s.kill("SIGKILL"), g(r("worker-timeout", "The native VST3 worker preflight timed out."));
    }, e.deadlineMs ?? AI);
    s.stdout.on("data", (_) => {
      m += _.byteLength, m > $l + 4 ? (s.kill("SIGKILL"), g(r("worker-invalid-response", "The native VST3 worker preflight exceeded the output limit."))) : d.push(_);
    }), s.once("error", () => {
      g(r("worker-unavailable", "The native VST3 worker could not start."));
    }), s.once("close", (_) => {
      if (!h) {
        if (_ !== 0) {
          g(r("worker-crashed", "The native VST3 worker preflight failed."));
          return;
        }
        try {
          const H = zI(Buffer.concat(d));
          g({
            version: Sn,
            type: "preflight-result",
            requestId: t,
            status: "available",
            requirements: es,
            hello: H
          });
        } catch {
          g(r("worker-invalid-response", "The native VST3 worker returned an invalid preflight response."));
        }
      }
    });
  });
}, ts = {
  slotCount: 2,
  maximumFrames: 512,
  inputChannels: 2,
  outputChannels: 2,
  maximumEventsPerBlock: 128
}, Ar = (e, t) => ({ ok: !1, code: e, message: t }), rs = (e) => {
  const t = e.filter((r) => r.enabled);
  return t.length === 1 && t[0]?.channels === 2;
}, TI = async (e) => {
  if (!e.catalog.entries.some((o) => o.classes.some((a) => a.classId === e.request.reference.classId && a.vendor === e.request.reference.vendorId))) return Ar("untrusted-catalog", "The selected VST3 class is not in the trusted native catalog.");
  const r = Nl(e.catalog, e.request.reference);
  if (!r) return Ar("stale-catalog", "The selected VST3 catalog identity is stale or no longer trusted.");
  if (r.role !== "effect")
    return Ar("unsupported-role", "Native VST3 instrument insertion is not supported.");
  const n = await (e.preflight ?? ql)({
    workerPath: e.workerPath,
    sampleRateHz: e.sampleRateHz,
    attachment: {
      graphNodeId: 1n,
      instanceId: e.request.instanceId,
      classId: r.classId,
      vendorId: r.vendorId,
      canonicalBundlePath: r.canonicalBundlePath,
      canonicalExecutablePath: r.canonicalExecutablePath,
      bundleFingerprint: r.bundleFingerprint,
      binaryFingerprint: r.binaryFingerprint,
      scannerProtocolVersion: r.scannerProtocolVersion,
      role: "effect",
      inputLayout: "stereo",
      outputLayout: "stereo",
      declaredLatencyFrames: 0,
      transportLatencyFrames: ts.maximumFrames,
      workerTransport: ts,
      stateRevision: 0
    }
  });
  return n.status === "unavailable" ? Ar(n.code, n.message) : n.hello.instanceId !== e.request.instanceId || n.hello.manifest.role !== "effect" || !rs(n.hello.manifest.inputBuses) || !rs(n.hello.manifest.outputBuses) ? Ar("unsupported-bus", "The VST3 plug-in does not expose one supported stereo input and output bus.") : {
    ok: !0,
    manifest: {
      role: "effect",
      inputBuses: n.hello.manifest.inputBuses,
      outputBuses: n.hello.manifest.outputBuses,
      parameters: n.hello.manifest.parameters ?? [],
      latencyFrames: n.hello.manifest.latencyFrames,
      tailFrames: n.hello.manifest.tailFrames,
      supportsBypass: n.hello.manifest.supportsBypass === !0,
      supportsEditor: n.hello.manifest.supportsEditor === !0,
      supportsState: n.hello.manifest.supportsState === !0
    }
  };
}, RI = (e) => [...e].sort((t, r) => t.graphNodeId.localeCompare(r.graphNodeId) || t.stageIndex - r.stageIndex || t.catalogIdentity.classId.localeCompare(r.catalogIdentity.classId) || t.instanceId.localeCompare(r.instanceId)), ns = (e, t) => e.length === t.length && e.every((r, n) => {
  const o = t[n];
  return o !== void 0 && r.name === o.name && r.channels === o.channels && r.enabled === o.enabled;
}), CI = (e, t) => e.length === t.length && e.every((r, n) => {
  const o = t[n];
  return o !== void 0 && r.id === o.id && r.title === o.title && r.unit === o.unit && r.minimum === o.minimum && r.maximum === o.maximum && r.defaultValue === o.defaultValue && r.stepCount === o.stepCount && r.readOnly === o.readOnly && r.hidden === o.hidden;
}), os = (e) => {
  const t = e.filter((r) => r.enabled);
  if (t.length === 1)
    return t[0].channels === 1 ? "mono" : t[0].channels === 2 ? "stereo" : void 0;
}, MI = (e, t) => {
  const r = t.hello.manifest;
  return t.hello.instanceId === e.instanceId && r.role === e.role && ns(r.inputBuses, e.inputBuses) && ns(r.outputBuses, e.outputBuses) && r.transport.slotCount === e.workerTransport.slotCount && r.transport.maximumFrames === e.workerTransport.maximumFrames && r.transport.inputChannels === e.workerTransport.inputChannels && r.transport.outputChannels === e.workerTransport.outputChannels && r.transport.maximumEventsPerBlock === e.workerTransport.maximumEventsPerBlock && r.latencyFrames === e.declaredLatencyFrames && r.tailFrames === e.declaredTailFrames && r.stateRevision === e.stateRevision && CI(e.parameters ?? [], r.parameters ?? []);
}, DI = (e, t) => {
  const r = Nl(e, {
    version: 1,
    classId: t.catalogIdentity.classId,
    vendorId: t.catalogIdentity.vendorId,
    architecture: t.catalogIdentity.architecture,
    bundleFingerprint: t.bundleFingerprint,
    binaryFingerprint: t.binaryFingerprint,
    scannerCatalogVersion: t.catalogIdentity.scannerCatalogVersion
  }), n = os(t.inputBuses), o = os(t.outputBuses);
  if (!(!r || r.role !== t.role || !n || !o))
    return {
      graphNodeId: BigInt(t.nativeGraphNodeId),
      instanceId: t.instanceId,
      classId: r.classId,
      vendorId: r.vendorId,
      canonicalBundlePath: r.canonicalBundlePath,
      canonicalExecutablePath: r.canonicalExecutablePath,
      bundleFingerprint: r.bundleFingerprint,
      binaryFingerprint: r.binaryFingerprint,
      scannerProtocolVersion: r.scannerProtocolVersion,
      role: r.role,
      inputLayout: n,
      outputLayout: o,
      declaredLatencyFrames: t.declaredLatencyFrames,
      transportLatencyFrames: t.workerTransport.maximumFrames,
      workerTransport: t.workerTransport,
      stateRevision: t.stateRevision,
      renderEnabled: !0
    };
}, Hl = async (e) => {
  let t;
  try {
    t = fI(e.serializedPlan);
  } catch {
    return { ok: !1, code: "invalid-plan", message: "The native external attachment plan is invalid." };
  }
  let r;
  try {
    r = await e.catalogStore.reload();
  } catch {
    return { ok: !1, code: "catalog-unavailable", message: "The trusted native plug-in catalog is unavailable." };
  }
  const n = [];
  for (const a of RI(t.attachments)) {
    const i = DI(r, a);
    if (!i)
      return {
        ok: !1,
        code: "attachment-unresolved",
        message: "A native VST3 attachment is stale or no longer trusted.",
        instanceId: a.instanceId
      };
    n.push({ attachment: a, native: i });
  }
  const o = e.preflight ?? ql;
  for (const a of n) {
    const i = await o({
      workerPath: e.workerPath,
      attachment: a.native,
      sampleRateHz: e.sampleRateHz
    });
    if (i.status === "unavailable")
      return {
        ok: !1,
        code: i.code,
        message: i.message,
        instanceId: a.attachment.instanceId
      };
    if (!MI(a.attachment, i))
      return {
        ok: !1,
        code: "manifest-mismatch",
        message: "The native VST3 worker manifest does not match the attachment plan.",
        instanceId: a.attachment.instanceId
      };
  }
  try {
    for (const a of n) {
      const { stateRevision: i, ...s } = a.native;
      await e.audioHost.attachVst(s);
    }
    return { ok: !0, attached: n.length };
  } catch {
    return { ok: !1, code: "native-transaction-failed", message: "The native VST3 attachment transaction failed." };
  }
}, VI = "98b2c88bb1cc8b8f23225e29e0a0760cc37dbcb6b6ef1fcd463ce4132d3813d3", OI = "d261d8b4d7f45ef88bc8ecbbed737036eda49e54537fd7685f3106e3bf20938c", BI = [{ name: "utility", id: 1, schemaVersion: 1, stateBytes: 40, tombstone: !1, parameters: [{ id: "gainDb", defaultValue: 0, minValue: -60, maxValue: 24 }, { id: "pan", defaultValue: 0, minValue: -1, maxValue: 1 }, { id: "balance", defaultValue: 0, minValue: -1, maxValue: 1 }, { id: "width", defaultValue: 1, minValue: 0, maxValue: 2 }] }, { name: "saturator", id: 2, schemaVersion: 1, stateBytes: 32, tombstone: !1, parameters: [] }, { name: "eq", id: 3, schemaVersion: 1, stateBytes: 200, tombstone: !1, parameters: [] }, { name: "chorus", id: 4, schemaVersion: 1, stateBytes: 28, tombstone: !1, parameters: [] }, { name: "flanger", id: 5, schemaVersion: 1, stateBytes: 28, tombstone: !1, parameters: [] }, { name: "phaser", id: 6, schemaVersion: 1, stateBytes: 32, tombstone: !1, parameters: [] }, { name: "tremolo", id: 7, schemaVersion: 1, stateBytes: 24, tombstone: !1, parameters: [] }, { name: "autopan", id: 8, schemaVersion: 1, stateBytes: 24, tombstone: !1, parameters: [] }, { name: "ensemble", id: 9, schemaVersion: 1, stateBytes: 28, tombstone: !1, parameters: [] }, { name: "gate", id: 10, schemaVersion: 1, stateBytes: 60, tombstone: !1, parameters: [] }, { name: "compressor", id: 11, schemaVersion: 1, stateBytes: 72, tombstone: !1, parameters: [] }, { name: "limiter", id: 12, schemaVersion: 1, stateBytes: 24, tombstone: !1, parameters: [] }, { name: "delay", id: 13, schemaVersion: 1, stateBytes: 32, tombstone: !1, parameters: [{ id: "delayMs", defaultValue: 250, minValue: 1, maxValue: 3e3 }, { id: "feedback", defaultValue: 0.25, minValue: 0, maxValue: 0.95 }, { id: "dryWet", defaultValue: 0.2, minValue: 0, maxValue: 1 }, { id: "lowCutHz", defaultValue: 120, minValue: 20, maxValue: 2e3 }, { id: "highCutHz", defaultValue: 8e3, minValue: 1e3, maxValue: 2e4 }] }, { name: "reverb", id: 14, schemaVersion: 1, stateBytes: 72, tombstone: !1, parameters: [{ id: "wet", defaultValue: 0.25, minValue: 0, maxValue: 1 }, { id: "preDelayMs", defaultValue: 20, minValue: 0, maxValue: 250 }, { id: "lowCutHz", defaultValue: 20, minValue: 20, maxValue: 1200 }, { id: "highCutHz", defaultValue: 2e4, minValue: 1200, maxValue: 2e4 }, { id: "stereoWidth", defaultValue: 1, minValue: 0, maxValue: 2 }] }, { name: "spectral", id: 15, schemaVersion: 1, stateBytes: 60, tombstone: !1, parameters: [{ id: "freeze", defaultValue: 0, minValue: 0, maxValue: 1 }, { id: "gateThresholdDb", defaultValue: -60, minValue: -120, maxValue: 0 }, { id: "gateAttackMs", defaultValue: 10, minValue: 0.1, maxValue: 1e3 }, { id: "gateReleaseMs", defaultValue: 100, minValue: 1, maxValue: 5e3 }, { id: "morph", defaultValue: 0, minValue: 0, maxValue: 1 }, { id: "binShift", defaultValue: 0, minValue: -2048, maxValue: 2048 }, { id: "blur", defaultValue: 0, minValue: 0, maxValue: 1 }, { id: "harmonicPercussiveBalance", defaultValue: 0, minValue: -1, maxValue: 1 }, { id: "noiseReduction", defaultValue: 0, minValue: 0, maxValue: 1 }, { id: "profileLearn", defaultValue: 0, minValue: 0, maxValue: 1 }, { id: "mix", defaultValue: 1, minValue: 0, maxValue: 1 }] }];
BI.find((e) => e.name === "utility")?.parameters;
const FI = 1, La = 1145132872, xn = 8, U = 16, Qn = 1048576, NI = {
  hostHello: 1,
  hostCapabilities: 2,
  deviceConfigure: 3,
  graphSnapshot: 4,
  assetInstall: 5,
  assetRelease: 6,
  transport: 7,
  parameterEvents: 8,
  midiEvents: 9,
  vstAttach: 10,
  vstDetach: 11,
  diagnostics: 12,
  ack: 13,
  notification: 14,
  start: 15,
  stop: 16,
  teardown: 17,
  sourceEvents: 18,
  deviceList: 19,
  transactionBegin: 20,
  transactionCommit: 21,
  transactionRollback: 22,
  vstParameterEvents: 23,
  recordingConfigure: 28,
  recordingStart: 29,
  recordingStop: 30,
  recordingCancel: 31,
  recordingBlock: 32,
  recordingStatus: 33,
  recordingDeviceQuery: 34,
  recordingDeviceList: 35,
  graphPrepare: 36,
  graphPublish: 37,
  graphRetire: 38,
  graphRollback: 39,
  graphRevisionStatus: 40,
  vstEditor: 41,
  vstEditorStatus: 42,
  diagnosticStart: 43
}, $I = 4096, mo = 24, qI = 64, HI = 262144, Jn = 256, as = 4096, is = 32, {
  hostHello: LI,
  hostCapabilities: Ll,
  deviceConfigure: UI,
  graphSnapshot: ZI,
  assetInstall: jI,
  assetRelease: KI,
  transport: WI,
  parameterEvents: GI,
  midiEvents: QI,
  vstAttach: JI,
  vstDetach: XI,
  diagnostics: ss,
  ack: YI,
  notification: eS,
  start: tS,
  stop: rS,
  teardown: nS,
  sourceEvents: oS,
  deviceList: cs,
  transactionBegin: ds,
  transactionCommit: ls,
  transactionRollback: us,
  vstParameterEvents: aS,
  recordingConfigure: iS,
  recordingStart: sS,
  recordingStop: cS,
  recordingCancel: dS,
  recordingBlock: lS,
  recordingStatus: uS,
  recordingDeviceQuery: pS,
  recordingDeviceList: mS,
  graphPrepare: fS,
  graphPublish: hS,
  graphRetire: gS,
  graphRollback: yS,
  graphRevisionStatus: bS,
  vstEditor: vS,
  vstEditorStatus: kS,
  diagnosticStart: wS
} = NI, ps = 511, IS = "daw-audio-host-macos/v3", SS = (e) => {
  if (e === 0) return "idle";
  if (e === 1) return "configured";
  if (e === 2) return "running";
  if (e === 3) return "faulted";
}, xS = (e) => {
  if (e === 0) return "ready";
  if (e === 1) return "device-not-configured";
  if (e === 2) return "graph-not-prepared";
  if (e === 3) return "transport-not-prepared";
}, Yt = (e, t = new Uint8Array()) => {
  if (t.byteLength > Qn) return;
  const r = Buffer.alloc(U + t.byteLength);
  return r.writeUInt32BE(La, 0), r.writeUInt32BE(xn, 4), r.writeUInt32BE(e, 8), r.writeUInt32BE(t.byteLength, 12), r.set(t, U), r;
}, fe = (e) => Number.isSafeInteger(e) && e >= 0 && e <= 4294967295, xe = (e) => {
  const t = Buffer.alloc(4);
  return t.writeUInt32BE(e), t;
}, ES = (e) => {
  const t = Buffer.alloc(8);
  return t.writeBigUInt64BE(e), t;
}, PS = (e) => {
  const t = Buffer.from(e.deviceId, "utf8");
  if (!(t.byteLength === 0 || t.byteLength > $I || !Mr(e.deviceId) || !fe(e.sampleRateHz) || e.sampleRateHz === 0 || !fe(e.maxFramesPerBlock) || e.maxFramesPerBlock === 0 || !fe(e.channelCount) || e.channelCount === 0 || !fe(e.revision) || e.revision === 0))
    return Buffer.concat([
      xe(e.sampleRateHz),
      xe(e.maxFramesPerBlock),
      xe(e.channelCount),
      xe(e.revision),
      xe(t.byteLength),
      t
    ]);
}, AS = (e) => {
  if (!fe(e.epoch) || !Number.isSafeInteger(e.frame)) return;
  const t = Buffer.alloc(16);
  return t.writeUInt32BE(e.epoch), t[4] = e.running ? 1 : 0, t.writeBigInt64BE(BigInt(e.frame), 8), t;
}, _S = (e) => {
  const t = Buffer.from(e.deviceUid, "utf8");
  if (!fe(e.generation) || e.generation === 0 || e.sessionId <= 0n || e.sessionId > 0xffffffffffffffffn || e.channelCount !== 1 && e.channelCount !== 2 || e.inputChannels.length !== e.channelCount || e.inputChannels.some((n) => !fe(n)) || !Number.isFinite(e.gain) || e.gain < 0 || e.polarity !== 1 && e.polarity !== -1 || !Number.isSafeInteger(e.punchStartFrame) || e.punchStartFrame < 0 || e.punchEndFrame !== null && (!Number.isSafeInteger(e.punchEndFrame) || e.punchEndFrame < e.punchStartFrame) || !Mr(e.deviceUid) || t.byteLength === 0 || t.byteLength > 4096) return;
  const r = Buffer.alloc(60 + t.byteLength);
  return r.writeUInt32BE(e.generation, 0), r.writeBigUInt64BE(e.sessionId, 4), r.writeUInt32BE(e.channelCount, 12), r.writeUInt32BE(e.inputChannels[0] ?? 0, 16), r.writeUInt32BE(e.inputChannels[1] ?? 0, 20), r.writeFloatBE(e.gain, 24), r.writeInt32BE(e.polarity, 28), r.writeBigInt64BE(BigInt(e.punchStartFrame), 32), r.writeBigInt64BE(BigInt(e.punchEndFrame ?? -1), 40), r.writeUInt32BE(e.monitoring ? 1 : 0, 48), r.writeUInt32BE(t.byteLength, 56), r.set(t, 60), r;
}, er = (e, t) => e.byteLength >= t && e.byteLength <= Qn ? Buffer.from(e) : void 0, zS = (e) => {
  const t = e.contentHashPrefix ?? new Uint8Array(8), r = e.frameCount * e.channelCount * 4;
  if (!fe(e.sessionAssetId) || e.sessionAssetId === 0 || !fe(e.frameCount) || e.frameCount === 0 || e.frameCount > HI || !fe(e.sampleRateHz) || e.sampleRateHz === 0 || !fe(e.channelCount) || e.channelCount === 0 || e.channelCount > qI || !Number.isSafeInteger(r) || r > Qn - mo || e.planarPcm.byteLength !== r || t.byteLength !== 8) return;
  const n = Buffer.alloc(mo + r);
  return n.writeUInt32BE(e.sessionAssetId, 0), n.writeUInt32BE(e.frameCount, 4), n.writeUInt32BE(e.sampleRateHz, 8), n.writeUInt32BE(e.channelCount, 12), n.set(t, 16), n.set(e.planarPcm, mo), n;
}, ms = (e) => /^[a-f0-9]{64}$/.test(e) ? Buffer.from(e, "hex") : void 0, TS = (e) => {
  const t = [e.instanceId, e.classId, e.vendorId];
  if (!t.every((a) => Buffer.byteLength(a, "utf8") > 0 && Buffer.byteLength(a, "utf8") <= Jn) || !e.canonicalBundlePath || !e.canonicalExecutablePath || Buffer.byteLength(e.canonicalBundlePath, "utf8") > as || Buffer.byteLength(e.canonicalExecutablePath, "utf8") > as || !e.canonicalExecutablePath.startsWith(`${e.canonicalBundlePath}/`) || e.scannerProtocolVersion !== 2 || e.graphNodeId <= 0n || e.role !== "effect" && e.role !== "instrument" || e.inputLayout !== "mono" && e.inputLayout !== "stereo" || e.outputLayout !== "mono" && e.outputLayout !== "stereo" || !fe(e.declaredLatencyFrames) || !fe(e.transportLatencyFrames) || !fe(e.workerTransport.slotCount) || e.workerTransport.slotCount === 0 || e.workerTransport.slotCount > 8 || !fe(e.workerTransport.maximumFrames) || e.workerTransport.maximumFrames === 0 || e.workerTransport.maximumFrames > 8192 || !fe(e.workerTransport.inputChannels) || e.workerTransport.inputChannels === 0 || e.workerTransport.inputChannels > 64 || !fe(e.workerTransport.outputChannels) || e.workerTransport.outputChannels === 0 || e.workerTransport.outputChannels > 64 || !fe(e.workerTransport.maximumEventsPerBlock) || e.workerTransport.maximumEventsPerBlock === 0 || e.workerTransport.maximumEventsPerBlock > Wn) return;
  const r = ms(e.bundleFingerprint), n = ms(e.binaryFingerprint);
  if (!r || !n || r.byteLength !== is || n.byteLength !== is)
    return;
  const o = [...t, e.canonicalBundlePath, e.canonicalExecutablePath].map((a) => Buffer.from(a, "utf8"));
  return Buffer.concat([
    ...o.flatMap((a) => [xe(a.byteLength), a]),
    ES(e.graphNodeId),
    Buffer.from([1]),
    r,
    n,
    xe(e.scannerProtocolVersion),
    Buffer.from([
      e.role === "effect" ? 1 : 2,
      e.inputLayout === "mono" ? 1 : 2,
      e.outputLayout === "mono" ? 1 : 2,
      e.renderEnabled === !0 ? 1 : 0
    ]),
    xe(e.declaredLatencyFrames),
    xe(e.transportLatencyFrames),
    xe(e.workerTransport.slotCount),
    xe(e.workerTransport.maximumFrames),
    xe(e.workerTransport.inputChannels),
    xe(e.workerTransport.outputChannels),
    xe(e.workerTransport.maximumEventsPerBlock)
  ]);
}, RS = (e) => {
  const t = Buffer.from(e, "utf8");
  if (!(t.byteLength === 0 || t.byteLength > Jn))
    return Buffer.concat([xe(t.byteLength), t]);
}, CS = (e) => {
  const t = Buffer.from(e.instanceId, "utf8"), r = { open: 1, close: 2, focus: 3, resize: 4, status: 5 }[e.command], n = e.width ?? 0, o = e.height ?? 0, a = e.anchor, i = a === void 0 ? 0 : 1;
  if (!r || t.byteLength === 0 || t.byteLength > Jn || !fe(n) || n > 8192 || !fe(o) || o > 8192 || a !== void 0 && e.command !== "open" && e.command !== "focus" || a !== void 0 && (!Number.isSafeInteger(a.x) || a.x < -2147483648 || a.x > 2147483647 || !Number.isSafeInteger(a.y) || a.y < -2147483648 || a.y > 2147483647)) return;
  const s = Buffer.alloc(28);
  return s.writeUInt32BE(r, 0), s.writeUInt32BE(n, 4), s.writeUInt32BE(o, 8), s.writeUInt32BE(i, 12), s.writeInt32BE(a?.x ?? 0, 16), s.writeInt32BE(a?.y ?? 0, 20), s.writeUInt32BE(t.byteLength, 24), Buffer.concat([s, t]);
}, Mr = (e) => e.startsWith("coreaudio:") && e.length > 10, MS = (e) => {
  if (!(e.byteLength >= U + 12 && e.readUInt32BE(0) === La && e.readUInt32BE(4) === xn && e.readUInt32BE(8) === Ll && e.readUInt32BE(U) === xn)) return;
  let t = U + 12;
  const r = () => {
    if (t + 4 > e.byteLength) return;
    const d = e.readUInt32BE(t);
    if (t += 4, d === 0 || t + d > e.byteLength) return;
    const m = e.subarray(t, t + d).toString("utf8");
    return t += d, m;
  }, n = r(), o = r(), a = r();
  if (!n || !o || !a || t + 8 !== e.byteLength) return;
  const i = SS(e.readUInt32BE(t)), s = xS(e.readUInt32BE(t + 4));
  if (!(!i || !s))
    return {
      capabilities: e.readUInt32BE(U + 4),
      abiVersion: e.readUInt32BE(U + 8),
      processorContractHash: n,
      graphContractHash: o,
      artifactId: a,
      deviceState: i,
      readinessReason: s
    };
}, DS = (e) => (e.capabilities & ps) === ps && e.abiVersion === FI && e.processorContractHash === VI && e.graphContractHash === OI && e.artifactId === IS, VS = (e, t, r) => t ? O.join(e, "daw-audio-host-macos") : r, fs = (e, t = (r) => Tn(r, [], { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] })) => {
  let r, n, o = Buffer.alloc(0), a, i, s, d = 0, m = Promise.resolve(), h;
  const g = /* @__PURE__ */ new Set(), S = /* @__PURE__ */ new Set(), _ = /* @__PURE__ */ new Set(), H = /* @__PURE__ */ new Set(), q = (I) => {
    const v = a;
    a = void 0, v && (clearTimeout(v.deadline), v.reject(I));
  }, u = (I, v = r) => {
    if (!v || r !== v) return;
    const f = new Error(I);
    q(f), r = void 0, n = void 0, i = void 0, h = void 0, o = Buffer.alloc(0), v?.kill();
    for (const y of g) y(f);
  }, p = (I) => {
    if (I.byteLength !== U + 40) return;
    const v = I.readUInt32BE(U);
    if (!(v !== 0 && v !== 1 && v !== 2 && v !== 3))
      return {
        state: v === 0 ? "idle" : v === 1 ? "configured" : v === 2 ? "running" : "faulted",
        activeRevision: I.readUInt32BE(U + 4),
        preparedRevision: I.readUInt32BE(U + 8),
        retiredRevision: I.readUInt32BE(U + 12),
        transportEpoch: I.readUInt32BE(U + 16),
        installedAssets: I.readUInt32BE(U + 20),
        callbacks: I.readUInt32BE(U + 24),
        rejectedBlocks: I.readUInt32BE(U + 28),
        renderEpoch: I.readBigUInt64BE(U + 32)
      };
  }, A = (I) => {
    if (I.byteLength !== U + 28) return;
    const v = I.readUInt32BE(U), f = v === 1 ? "prepared" : v === 2 ? "published" : v === 3 ? "retired" : v === 4 ? "rolled-back" : v === 5 ? "stale-revision" : v === 6 ? "invalid-revision" : v === 7 ? "prepare-failed" : v === 8 ? "publish-failed" : v === 9 ? "retirement-not-safe" : void 0;
    if (f)
      return {
        status: f,
        requestedRevision: I.readUInt32BE(U + 4),
        activeRevision: I.readUInt32BE(U + 8),
        preparedRevision: I.readUInt32BE(U + 12),
        retiredRevision: I.readUInt32BE(U + 16),
        renderEpoch: I.readBigUInt64BE(U + 20)
      };
  }, C = (I) => {
    if (I.byteLength !== U + 20) return;
    const v = I.readUInt32BE(U);
    if (!(v > 1 || I.readUInt32BE(U + 4) > 1 || I.readUInt32BE(U + 8) > 1))
      return {
        success: v === 1,
        supported: I.readUInt32BE(U + 4) === 1,
        open: I.readUInt32BE(U + 8) === 1,
        width: I.readUInt32BE(U + 12),
        height: I.readUInt32BE(U + 16)
      };
  }, L = (I) => {
    const v = I.subarray(U);
    if (v.byteLength < 24) return;
    const f = v.readUInt32BE(0), w = f === 1 ? "latency" : f === 2 ? "buses" : f === 3 ? "restart" : f === 4 ? "fault" : f === 5 ? "miss" : f === 6 ? "editor-interaction" : void 0, y = v.readUInt32BE(20);
    if (!(!w || y === 0 || y > Jn || v.byteLength !== 24 + y))
      return {
        kind: w,
        graphRevision: v.readUInt32BE(4),
        graphNodeId: v.readBigUInt64BE(8),
        value: v.readUInt32BE(16),
        instanceId: v.subarray(24).toString("utf8")
      };
  }, K = (I) => {
    const v = I.subarray(U);
    if (v.byteLength === 4 && v.readUInt32BE(0) === 0) return null;
    if (v.byteLength < 4 || v.readUInt32BE(0) !== 1) return;
    let f = 4;
    const w = () => {
      if (f + 4 > v.byteLength) return;
      const ve = v.readUInt32BE(f);
      if (f += 4, ve === 0 || f + ve > v.byteLength) return;
      const $e = v.subarray(f, f + ve).toString("utf8");
      return f += ve, $e;
    }, y = w(), x = w();
    if (!y || !Mr(y) || !x || f + 16 !== v.byteLength) return;
    const D = v.readUInt32BE(f), j = v.readUInt32BE(f + 4), ae = v.readUInt32BE(f + 8), ue = v.readUInt32BE(f + 12);
    if (!(ue !== 0 && ue !== 1))
      return { deviceId: y, name: x, nominalSampleRateHz: D, outputChannelCount: j, maximumFramesPerBlock: ae, available: ue === 1 };
  }, Ce = (I) => {
    const v = K(I);
    return v == null ? v : {
      deviceId: v.deviceId,
      name: v.name,
      nominalSampleRateHz: v.nominalSampleRateHz,
      inputChannelCount: v.outputChannelCount,
      maximumFramesPerBlock: v.maximumFramesPerBlock,
      available: v.available
    };
  }, qe = (I) => I <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(I) : void 0, He = (I) => {
    const v = I.subarray(U);
    if (v.byteLength < 32) return;
    const f = v.readUInt32BE(20), w = v.readUInt32BE(16), y = w * f * Float32Array.BYTES_PER_ELEMENT;
    if (!(f !== 1 && f !== 2 || w === 0 || w > 2048 || y !== v.byteLength - 32))
      return {
        generation: v.readUInt32BE(0),
        sessionId: v.readBigUInt64BE(4),
        sequence: v.readUInt32BE(12),
        frameCount: w,
        channelCount: f,
        rms: v.readFloatBE(24),
        peak: v.readFloatBE(28),
        planarPcm: Uint8Array.from(v.subarray(32))
      };
  }, Jt = (I) => {
    const v = I.subarray(U);
    if (v.byteLength !== 60) return;
    const f = v.readBigInt64BE(12), w = qe(v.readBigUInt64BE(20)), y = qe(v.readBigUInt64BE(28)), x = v.readUInt32BE(56);
    if (!(f < 0 || f > BigInt(Number.MAX_SAFE_INTEGER) || w === void 0 || y === void 0 || (x & -8) !== 0))
      return {
        generation: v.readUInt32BE(0),
        sessionId: v.readBigUInt64BE(4),
        timelineFrame: Number(f),
        capturedFrames: w,
        droppedFrames: y,
        droppedBlocks: v.readUInt32BE(36),
        availableBlocks: v.readUInt32BE(40),
        queuedBlocks: v.readUInt32BE(44),
        rms: v.readFloatBE(48),
        peak: v.readFloatBE(52),
        fatal: (x & 1) !== 0,
        active: (x & 2) !== 0,
        configured: (x & 4) !== 0
      };
  }, Qe = (I) => {
    for (o = Buffer.concat([o, I]); o.byteLength >= U; ) {
      const v = o.readUInt32BE(12);
      if (v > Qn || o.byteLength < U + v) return;
      const f = o.subarray(0, U + v);
      if (o = o.subarray(U + v), f.readUInt32BE(0) !== La || f.readUInt32BE(4) !== xn) return u("The native audio host returned an invalid control frame.");
      if (f.readUInt32BE(8) === lS) {
        const w = He(f);
        if (!w) return u("The native audio host returned an invalid recording block.");
        for (const y of S) y(w);
      } else if (f.readUInt32BE(8) === uS) {
        const w = Jt(f);
        if (!w) return u("The native audio host returned invalid recording status.");
        for (const y of _) y(w);
      } else if (f.readUInt32BE(8) === eS) {
        const w = L(f);
        if (!w) return u("The native audio host returned an invalid worker notification.");
        for (const y of H) y(w);
      } else if (f.readUInt32BE(8) === Ll && !n) {
        const w = MS(f);
        if (!w || !DS(w))
          return u("The native audio host returned an incompatible protocol response.");
        n = w, a && (clearTimeout(a.deadline), a.resolve()), a = void 0;
      } else if (f.readUInt32BE(8) === ss && a?.diagnosticsResolve) {
        const w = a.diagnosticsResolve, y = p(f);
        if (!y) return u("The native audio host returned an invalid diagnostics response.");
        clearTimeout(a.deadline), a = void 0, w(y);
      } else if (f.readUInt32BE(8) === cs && a?.devicesResolve) {
        const w = a.devicesResolve, y = K(f);
        if (y === void 0) return u("The native audio host returned an invalid device response.");
        clearTimeout(a.deadline), a = void 0, w(y);
      } else if (f.readUInt32BE(8) === mS && a?.inputDeviceResolve) {
        const w = a.inputDeviceResolve, y = Ce(f);
        if (y === void 0) return u("The native audio host returned an invalid input device response.");
        clearTimeout(a.deadline), a = void 0, w(y);
      } else if (f.readUInt32BE(8) === bS && a?.graphRevisionResolve) {
        const w = a.graphRevisionResolve, y = A(f);
        if (!y) return u("The native audio host returned an invalid graph revision status.");
        clearTimeout(a.deadline), a = void 0, w(y);
      } else if (f.readUInt32BE(8) === kS && a?.editorResolve) {
        const w = a.editorResolve, y = C(f);
        if (!y) return u("The native audio host returned an invalid VST editor response.");
        clearTimeout(a.deadline), a = void 0, w(y);
      } else if (f.readUInt32BE(8) === YI && f.byteLength === U + 8 && a && f.readUInt32BE(U) === a.expectedAckType && f.readUInt32BE(U + 4) === 1)
        a && (clearTimeout(a.deadline), a.resolve()), a = void 0;
      else return u("The native audio host rejected a control request.");
    }
  }, Be = (I, v, f, w = !1) => new Promise((y, x) => {
    if (!r || a || s && !w || typeof h == "symbol" && h !== f) return x(new Error("The native audio host is unavailable."));
    const D = Yt(I, v);
    if (!D) return x(new Error("The native audio host protocol is unavailable."));
    const j = r, ae = setTimeout(() => u("The native audio host control request timed out.", j), 2e3);
    a = { resolve: y, reject: x, deadline: ae, expectedAckType: I }, r.stdin.write(D);
  }), oe = async (I, v) => {
    await Je.start(), await Be(I, v);
  }, wt = async (I, v) => {
    await Je.start();
    const f = r;
    if (!f || a) throw new Error("The native audio host is unavailable.");
    const w = Yt(I, v);
    if (!w) throw new Error("The native audio host protocol is unavailable.");
    return new Promise((y, x) => {
      a = { deadline: setTimeout(() => u("The native audio host graph revision request timed out.", f), 2e3), reject: x, resolve: () => {
      }, graphRevisionResolve: y }, f.stdin.write(w);
    });
  }, kr = async (I, v) => {
    const f = TS(I);
    if (!f) throw new Error("The native VST attachment is invalid.");
    await Je.start(), await Be(JI, f, v);
  }, Je = {
    start() {
      if (s) return Promise.reject(new Error("The native audio host is tearing down."));
      if (n) return Promise.resolve(n);
      if (i) return i;
      const I = d;
      let v;
      const f = (async () => {
        if (await qo(e), I !== d || s)
          throw new Error("The native audio host startup was cancelled.");
        if (v = t(e), r = v, v.once("error", () => u("The native audio host could not start.", v)), v.once("close", () => {
          s && r === v || u("The native audio host stopped.", v);
        }), v.stderr.resume(), v.stdout.on("data", (w) => {
          r === v && Qe(w);
        }), await Be(LI), r !== v || !n) throw new Error("The native audio host did not complete its handshake.");
        return n;
      })();
      return i = f, f.then(
        () => {
          i === f && (i = void 0);
        },
        () => {
          i === f && (i = void 0), v && r === v && u("The native audio host could not start.", v);
        }
      ), f;
    },
    runTransaction(I) {
      const v = m.then(async () => {
        const f = d;
        if (await Je.start(), f !== d || s)
          throw new Error("The native audio host transaction was cancelled.");
        if (h) throw new Error("The native audio host transaction is unavailable.");
        const w = Symbol("native-audio-host-transaction");
        h = w;
        let y = !1;
        try {
          await Be(ds, void 0, w), y = !0;
          const x = await I({
            attachVst: (D) => kr(D, w)
          });
          return await Be(ls, void 0, w), y = !1, x;
        } catch (x) {
          if (y)
            try {
              await Be(us, void 0, w);
            } catch {
            }
          throw x;
        } finally {
          h === w && (h = void 0);
        }
      });
      return m = v.then(() => {
      }, () => {
      }), v;
    },
    async configure(I) {
      const v = PS(I);
      if (!v) throw new Error("The native audio host configuration is invalid.");
      await oe(UI, v);
    },
    async beginTransaction() {
      if (h) throw new Error("The native audio host transaction is unavailable.");
      await oe(ds), h = "manual";
    },
    async commitTransaction() {
      if (h !== "manual") throw new Error("The native audio host transaction is unavailable.");
      try {
        await oe(ls);
      } finally {
        h = void 0;
      }
    },
    async rollbackTransaction() {
      if (h !== "manual") throw new Error("The native audio host transaction is unavailable.");
      try {
        await oe(us);
      } finally {
        h = void 0;
      }
    },
    async attachVst(I) {
      await kr(I);
    },
    async detachVst(I) {
      const v = RS(I);
      if (!v) throw new Error("The native VST attachment is invalid.");
      await oe(XI, v);
    },
    async executeVstEditorCommand(I) {
      const v = CS(I);
      if (!v) throw new Error("The native VST editor command is invalid.");
      await Je.start();
      const f = r;
      if (!f || a) throw new Error("The native audio host is unavailable.");
      const w = Yt(vS, v);
      if (!w) throw new Error("The native audio host protocol is unavailable.");
      return new Promise((y, x) => {
        a = { deadline: setTimeout(() => u("The native VST editor command timed out.", f), 2e3), reject: x, resolve: () => {
        }, editorResolve: y }, f.stdin.write(w);
      });
    },
    async installAsset(I) {
      const v = zS(I);
      if (!v) throw new Error("The native audio host asset is invalid.");
      await oe(jI, v);
    },
    async releaseAsset(I) {
      if (!fe(I) || I === 0) throw new Error("The native audio host asset is invalid.");
      await oe(KI, xe(I));
    },
    async publishGraph(I) {
      const v = er(I, 13);
      if (!v) throw new Error("The native audio host graph payload is invalid.");
      await oe(ZI, v);
    },
    async prepareGraphRevision(I) {
      const v = er(I, 13);
      if (!v) throw new Error("The native audio host graph payload is invalid.");
      return wt(fS, v);
    },
    async publishGraphRevision(I) {
      if (!fe(I) || I === 0) throw new Error("The native audio host graph revision is invalid.");
      return wt(hS, xe(I));
    },
    async rollbackGraphRevision(I) {
      if (!fe(I) || I === 0) throw new Error("The native audio host graph revision is invalid.");
      return wt(yS, xe(I));
    },
    async retireGraphRevision(I) {
      if (!fe(I) || I === 0) throw new Error("The native audio host graph revision is invalid.");
      return wt(gS, xe(I));
    },
    async queueParameterEvents(I) {
      const v = er(I, 4);
      if (!v) throw new Error("The native audio host parameter payload is invalid.");
      await oe(GI, v);
    },
    async queueVstParameterEvents(I) {
      const v = er(I, 8);
      if (!v) throw new Error("The native VST parameter payload is invalid.");
      await oe(aS, v);
    },
    async queueInstrumentEvents(I) {
      const v = er(I, 4);
      if (!v) throw new Error("The native audio host instrument payload is invalid.");
      await oe(QI, v);
    },
    async queueSourceEvents(I) {
      const v = er(I, 4);
      if (!v) throw new Error("The native audio host source payload is invalid.");
      await oe(oS, v);
    },
    async setTransport(I) {
      const v = AS(I);
      if (!v) throw new Error("The native audio host transport is invalid.");
      await oe(WI, v);
    },
    async resolveOutputDevice(I) {
      await Je.start();
      const v = r;
      if (!v || a || I !== void 0 && !Mr(I))
        throw new Error("The native audio host device request is invalid.");
      const f = I === void 0 ? void 0 : Buffer.from(I, "utf8"), w = Yt(cs, f);
      if (!w) throw new Error("The native audio host protocol is unavailable.");
      return new Promise((y, x) => {
        a = { deadline: setTimeout(() => u("The native audio host device request timed out."), 2e3), reject: x, resolve: () => {
        }, devicesResolve: y }, v.stdin.write(w);
      });
    },
    async resolveInputDevice(I) {
      await Je.start();
      const v = r;
      if (!v || a || I !== void 0 && !Mr(I))
        throw new Error("The native audio host input device request is invalid.");
      const f = I === void 0 ? void 0 : Buffer.from(I, "utf8"), w = Yt(pS, f);
      if (!w) throw new Error("The native audio host protocol is unavailable.");
      return new Promise((y, x) => {
        a = { deadline: setTimeout(() => u("The native audio host input device request timed out."), 2e3), reject: x, resolve: () => {
        }, inputDeviceResolve: y }, v.stdin.write(w);
      });
    },
    async startAudio() {
      await oe(tS);
    },
    async startDiagnosticAudio() {
      await oe(wS);
    },
    async stopAudio() {
      await oe(rS);
    },
    async diagnostics() {
      await Je.start();
      const I = r;
      if (!I || a) throw new Error("The native audio host is unavailable.");
      const v = Yt(ss);
      if (!v) throw new Error("The native audio host protocol is unavailable.");
      return new Promise((f, w) => {
        a = {
          deadline: setTimeout(() => u("The native audio host diagnostics timed out."), 2e3),
          reject: w,
          resolve: () => {
          },
          diagnosticsResolve: f
        }, I.stdin.write(v);
      });
    },
    async configureRecording(I) {
      const v = _S(I);
      if (!v) throw new Error("The native recording configuration is invalid.");
      await oe(iS, v);
    },
    async startRecording() {
      await oe(sS);
    },
    async stopRecording(I) {
      if (I !== void 0 && (!Number.isSafeInteger(I) || I < 0))
        throw new Error("The native recording stop frame is invalid.");
      let v;
      I !== void 0 && (v = Buffer.alloc(8), v.writeBigInt64BE(BigInt(I))), await oe(cS, v);
    },
    async cancelRecording() {
      await oe(dS);
    },
    teardown() {
      if (s) return s;
      d += 1;
      const I = r, v = a !== void 0, f = (async () => {
        try {
          v ? q(new Error("The native audio host is tearing down.")) : I && n && !h && await Be(nS, void 0, void 0, !0);
        } finally {
          q(new Error("The native audio host is tearing down.")), h = void 0, r === I && (r = void 0), n = void 0, o = Buffer.alloc(0), I?.kill();
        }
      })();
      return s = f, f.then(
        () => {
          s === f && (s = void 0);
        },
        () => {
          s === f && (s = void 0);
        }
      ), f;
    },
    status: () => ({ running: r !== void 0 && n !== void 0, ...n ? { hello: n } : {} }),
    onLoss(I) {
      return g.add(I), () => g.delete(I);
    },
    onRecordingBlock(I) {
      return S.add(I), () => S.delete(I);
    },
    onRecordingStatus(I) {
      return _.add(I), () => _.delete(I);
    },
    onWorkerNotification(I) {
      return H.add(I), () => H.delete(I);
    }
  };
  return Je;
}, hs = {
  deviceId: "coreaudio:editor",
  sampleRateHz: 44100,
  maxFramesPerBlock: 8192,
  channelCount: 2,
  revision: 1
}, OS = {
  success: !1,
  supported: !1,
  open: !1,
  width: 0,
  height: 0
}, BS = (e) => e === "open" || e === "focus" || e === "status", FS = (e) => {
  const t = /* @__PURE__ */ new Map();
  let r = !1;
  const n = async (i) => {
    const s = i.supervisor;
    i.unsubscribeInteraction?.(), i.unsubscribeInteraction = void 0, i.supervisor = void 0, await s?.teardown();
  }, o = async (i, s, d) => {
    const m = e.createSupervisor();
    s.supervisor = m, s.unsubscribeInteraction = m.onWorkerNotification((g) => {
      g.kind === "editor-interaction" && g.instanceId === i && e.onEditorInteraction?.(i);
    });
    let h = !1;
    try {
      await m.beginTransaction(), h = !0, await m.configure(hs);
      const g = await (e.coordinate ?? Hl)({
        serializedPlan: d,
        sampleRateHz: hs.sampleRateHz,
        workerPath: e.workerPath,
        catalogStore: e.catalogStore,
        audioHost: m
      });
      if (!g.ok) throw new Error(g.message);
      await m.commitTransaction(), h = !1, await m.startDiagnosticAudio();
    } catch (g) {
      if (h)
        try {
          await m.rollbackTransaction();
        } catch {
        }
      throw await n(s), g;
    }
  }, a = (i, s) => {
    const d = t.get(i) ?? { queue: Promise.resolve() };
    t.set(i, d);
    const m = d.queue.then(() => s(d)), h = () => {
      t.get(i) === d && d.queue === g && !d.supervisor && t.delete(i);
    }, g = m.then(h, h);
    return d.queue = g, m;
  };
  return {
    execute(i) {
      return r ? Promise.reject(new Error("The native VST editor session is shutting down.")) : a(i.instanceId, async (s) => {
        if (i.command === "close") {
          let d = OS;
          try {
            s.supervisor && (d = await s.supervisor.executeVstEditorCommand(i));
          } finally {
            await n(s);
          }
          return d;
        }
        if (!s.supervisor) {
          if (!BS(i.command) || i.serializedPlan === void 0)
            throw new Error("The native VST editor session is unavailable.");
          await o(i.instanceId, s, i.serializedPlan);
        }
        if (!s.supervisor) throw new Error("The native VST editor session is unavailable.");
        try {
          return await s.supervisor.executeVstEditorCommand(i);
        } catch (d) {
          throw await n(s), d;
        }
      });
    },
    async teardownAll() {
      r = !0;
      const i = [...t.entries()];
      await Promise.all(i.map(async ([, s]) => {
        await s.queue, await n(s);
      })), t.clear();
    }
  };
}, Ul = "daw-native-artifacts-v1.json", Zl = "daw-vst3-scanner", jl = "daw-audio-host-macos", lr = [
  Zl,
  Xr,
  jl
], NS = (e) => typeof e == "string" && lr.some((t) => t === e), $S = (e) => {
  if (typeof e != "object" || e === null || !("version" in e) || e.version !== 1 || !("artifacts" in e) || !Array.isArray(e.artifacts) || e.artifacts.length !== lr.length) return !1;
  const t = /* @__PURE__ */ new Set();
  for (const r of e.artifacts) {
    if (typeof r != "object" || r === null || !("name" in r) || !NS(r.name) || !("sha256" in r) || typeof r.sha256 != "string" || !/^[a-f0-9]{64}$/.test(r.sha256) || t.has(r.name)) return !1;
    t.add(r.name);
  }
  return lr.every((r) => t.has(r));
}, qS = async (e) => {
  const t = _n("sha256");
  for await (const r of Ho(e)) {
    if (!(r instanceof Uint8Array)) throw new Error(`Release artifact could not be hashed: ${e}`);
    t.update(r);
  }
  return t.digest("hex");
}, HS = async (e) => {
  let t;
  try {
    t = JSON.parse(await Ss(e, "utf8"));
  } catch {
    throw new Error(`Native release artifact manifest is unavailable: ${e}`);
  }
  if (!$S(t)) throw new Error(`Native release artifact manifest is invalid: ${e}`);
  return t;
}, LS = (e) => {
  if (e.length !== lr.length) throw new Error("Native release artifact plan is incomplete.");
  const t = /* @__PURE__ */ new Map();
  for (const n of e) {
    if (t.has(n.name) || O.basename(n.sourcePath) !== n.name)
      throw new Error(`Native release artifact path does not preserve its packaged identity: ${n.sourcePath}`);
    t.set(n.name, n);
  }
  const r = [];
  for (const n of lr) {
    const o = t.get(n);
    if (!o) throw new Error("Native release artifact plan is incomplete.");
    r.push(o);
  }
  return r;
}, US = async (e, t) => {
  const r = LS(e), n = await HS(t), o = new Map(n.artifacts.map((a) => [a.name, a.sha256]));
  for (const a of r) {
    if (!(await ur(a.sourcePath).catch(() => {
    }))?.isFile()) throw new Error(`Required native release artifact is not a file: ${a.sourcePath}`);
    if (await qS(a.sourcePath) !== o.get(a.name))
      throw new Error(`Native release artifact hash does not match its manifest: ${a.name}`);
  }
}, ZS = (e) => lr.map((t) => ({ name: t, sourcePath: O.join(e, t) })), jS = async (e) => {
  const t = ZS(e);
  return await US(
    t,
    O.join(e, Ul)
  ), {
    scannerPath: O.join(e, Zl),
    workerPath: O.join(e, Xr),
    audioHostPath: O.join(e, jl)
  };
}, gs = "daw://app", Ua = (e) => e === gs || e.startsWith(`${gs}/`), ys = (e) => e.permission === "media" && Ua(e.requestingUrl) && e.mediaTypes?.length === 1 && e.mediaTypes[0] === "audio", bs = (e) => e.permission === "midi" && e.trustedRendererId !== void 0 && e.requestingRendererId === e.trustedRendererId && e.isMainFrame && Ua(e.requestingUrl), KS = (e) => O.join(e, ".vite", "renderer", "main_window"), WS = (e, t) => {
  let r;
  try {
    r = decodeURIComponent(new URL(t).pathname);
  } catch {
    return;
  }
  const n = O.resolve(e), o = O.resolve(n, `.${r === "/" ? "/index.html" : r}`);
  return o !== n && o.startsWith(`${n}${O.sep}`) ? o : void 0;
};
ks.registerSchemesAsPrivileged([{ scheme: "daw", privileges: { standard: !0, secure: !0, supportFetchAPI: !0, corsEnabled: !0 } }]);
const Za = "daw:host-request", GS = "daw:host-response", Kl = "daw-browser", fo = (e) => (e instanceof Error ? e.message : "The native VST editor session is unavailable.").replace(/(?:[A-Za-z]:[\\/]|\/)[^\s]*/g, "<path>").slice(0, 256), ho = O.join(import.meta.dirname, "preload.js"), QS = (e) => {
  try {
    return new URL(e).protocol === "https:";
  } catch {
    return !1;
  }
}, et = Ua;
let X, lt = 0;
const vt = /* @__PURE__ */ new Map(), At = Iw(), Zt = /* @__PURE__ */ new Map(), En = /* @__PURE__ */ new Map(), Vo = /* @__PURE__ */ new Set(), JS = (e) => [...Zt.values()].some((t) => t.requestId === e.requestId && t.rendererGeneration === e.rendererGeneration), Oo = Vr(16).toString("hex"), Wl = Vr(32).toString("hex");
let Dr = "", qt = "", Pn;
const An = /* @__PURE__ */ new Set();
let Ur = !1, ja = !1, ar, tr, Ht, Se, Ka, Gl, jt = { status: "disabled" }, Ql, Jl, Xl, Yl;
const eu = dw(), ke = kw({
  dialog: {
    showOpenDialog: (e) => ln.showOpenDialog(e),
    showSaveDialog: (e) => ln.showSaveDialog(e)
  },
  nativeHelper: eu,
  nativeOutputEnabled: () => ja,
  privateTempDirectory: () => O.join(ze.getPath("userData"), "output-temp")
}), Zr = (e) => {
  e.catch(() => {
  });
}, go = () => Sw(ja), XS = (e, t, r) => j0(t, r), YS = (e, t, r) => zl(t, r), ex = (e, t, r) => {
  if (r !== Pe || br(e) && Fr.safeParse(t).success) return t;
  const n = $r.safeParse(t);
  return n.success ? zl(n.data.code, n.data.message) : t;
}, dn = (e, t, r, n, o, a) => {
  if (t === Pe) {
    e.write(qr({
      version: Pe,
      type: "reply",
      id: n,
      error: YS(r, o, a)
    }));
    return;
  }
  e.write(qr({
    version: Ge,
    type: "reply",
    id: n,
    error: XS(r, o, a)
  }));
}, Wa = (e, t) => {
  const r = X?.webContents;
  !r || r.isDestroyed() || !et(r.getURL()) || r.send(Za, {
    generation: t,
    frame: { version: Ge, type: "cancel", id: e }
  });
}, Bo = (e) => {
  const t = En.get(e);
  if (!t) return;
  En.delete(e);
  const r = X?.webContents;
  !r || r.isDestroyed() || !et(r.getURL()) || r.send(Za, {
    generation: lt,
    frame: {
      version: Ge,
      type: "request",
      id: e,
      operation: "host.export.run",
      input: Pt.parse({ canceled: !0, mode: t })
    }
  });
}, Fo = (e) => {
  for (const [t, r] of vt)
    Wa(t, r.generation), r.reject(new Error(e));
  vt.clear();
}, vs = (e, t) => {
  const r = vt.get(e);
  r && (vt.delete(e), Wa(e, r.generation), r.reject(new Error(t)));
}, tx = (e) => new Promise((t, r) => {
  const n = X?.webContents;
  if (!n || n.isDestroyed() || !et(n.getURL())) {
    r(new Error("Renderer unavailable."));
    return;
  }
  if (vt.has(e.id)) {
    r(new Error("Duplicate request ID."));
    return;
  }
  const o = lt;
  vt.set(e.id, { generation: o, resolve: t, reject: r }), n.send(Za, { generation: o, frame: e });
}), Ga = async (e, t, r, n = 1e4, o) => {
  const a = { version: Ge, type: "request", id: r, operation: e, input: t, deadlineMs: n }, i = e !== "lifecycle.prepareToClose" && br(e) ? z0.parse({ ...a, actorSubject: o }) : kl.parse(a);
  let s, d = !1;
  try {
    return await Promise.race([
      tx(i),
      new Promise((m, h) => {
        s = setTimeout(() => {
          d = !0, h(new Error("Renderer deadline exceeded."));
        }, n);
      })
    ]);
  } finally {
    s && clearTimeout(s);
    const m = vt.get(r);
    d && m && Wa(r, m.generation), vt.delete(r);
  }
}, rx = async (e, t, r, n) => {
  if (n.throwIfAborted(), e === "host.import.audio") {
    const o = m0.parse(t), a = o.source.kind === "picker" ? await ke.pickReadFiles(r) : { canceled: !1, files: [await ke.grantReadFile(r, o.source.path)] };
    return n.throwIfAborted(), bl.parse(
      a.canceled ? { canceled: !0 } : { canceled: !1, files: a.files }
    );
  }
  if (e === "host.export.run") {
    const o = jn.parse(t), a = o.mode === "mixdown" ? o.format === "ogg-opus" ? "ogg" : o.format : void 0, i = o.mode === "mixdown" ? { kind: "capability-file", token: "0".repeat(64), basename: `preflight.${a}` } : { kind: "capability-directory", token: "0".repeat(64), basename: "preflight" }, s = await Ga("host.export.run", Pt.parse({
      ...o,
      canceled: !1,
      preflightOnly: !0,
      destination: i
    }), r.requestId);
    if (s.error) throw new Error(s.error.message);
    En.set(r.requestId, o.mode);
    try {
      n.throwIfAborted();
      const d = o.destination;
      if (d.kind === "file" || d.kind === "file-picker") {
        const h = d.kind === "file-picker" ? await ke.pickOutputFile(r, o.mode === "mixdown" ? o.format : void 0) : { canceled: !1, file: await ke.grantOutputFile(r, d.path) };
        return n.throwIfAborted(), h.canceled ? Pt.parse({ canceled: !0, mode: "mixdown" }) : Pt.parse({ ...o, destination: { kind: "capability-file", token: h.file.token, basename: h.file.basename }, canceled: !1 });
      }
      const m = d.kind === "directory-picker" ? await ke.pickDirectory(r) : { canceled: !1, directory: await ke.grantDirectory(r, d.path) };
      return n.throwIfAborted(), m.canceled ? Pt.parse({ canceled: !0, mode: "stems" }) : Pt.parse({ ...o, destination: { kind: "capability-directory", token: m.directory.token, basename: m.directory.basename }, canceled: !1 });
    } catch (d) {
      throw Bo(r.requestId), d;
    } finally {
      En.delete(r.requestId);
    }
  }
  return t;
}, nx = async () => {
  for (const e of An) e.destroy();
  An.clear(), await new Promise((e) => Pn?.close(() => e()) ?? e()), Pn = void 0, qt && await bo(qt, { force: !0 }).catch(() => {
  }), Dr && await bo(Dr, { force: !0 }).catch(() => {
  });
}, tu = () => O.join(ze.getPath("userData"), "host"), ox = () => process.platform === "win32" ? `\\\\.\\pipe\\${Kl}-${Oo}` : O.join(tu(), `${Oo}.sock`), ax = (e) => {
  const t = Buffer.from(e, "hex"), r = Buffer.from(Wl, "hex");
  return t.byteLength === r.byteLength && cu(t, r);
}, ix = async () => {
  const e = tu();
  process.platform === "win32" ? await yo(e, { recursive: !0 }) : (await yo(e, { recursive: !0, mode: 448 }), await eo(e, 448)), qt = ox(), process.platform !== "win32" && await bo(qt, { force: !0 }), Pn = ou((r) => sx(r)), await new Promise((r, n) => Pn?.once("error", n).listen(qt, r)), process.platform !== "win32" && await eo(qt, 384), Dr = O.join(e, "registration-v1.json");
  const t = q0.parse({
    version: Ge,
    instanceId: Oo,
    pid: process.pid,
    createdAt: Date.now(),
    address: qt,
    secret: Wl
  });
  await Is(Dr, JSON.stringify(t), process.platform === "win32" ? void 0 : { mode: 384 }), process.platform !== "win32" && await eo(Dr, 384);
}, sx = (e) => {
  let t = !1, r, n;
  const o = ww(), a = /* @__PURE__ */ new Map(), i = /* @__PURE__ */ new Set(), s = Vr(16).toString("hex");
  An.add(e);
  let d = !1;
  const m = () => {
    if (d) return;
    d = !0, An.delete(e);
    for (const S of a.values())
      S.abort(), At.delete(S);
    a.clear();
    const g = [...o.internalIds()];
    for (const S of g)
      Bo(S), i.has(S) || vs(S, "Desktop host connection closed.");
    o.clear();
    for (const S of g)
      i.has(S) || Zr(ke.revokeRequest({ requestId: S, rendererGeneration: lt }));
  }, h = G0((g) => {
    if (!t) {
      const u = Ro.safeParse(g).success ? Ro.safeParse(g) : _l.safeParse(g);
      if (!u.success || !ax(u.data.secret)) {
        e.destroy();
        return;
      }
      t = !0, r = u.data.version, n = `local:${u.data.actorId}`, e.write(qr(
        r === Pe ? { version: Pe, type: "helloAck", selectedVersion: Pe, sessionId: s, capabilities: go() } : { version: Ge, type: "helloAck", sessionId: s, capabilities: go() }
      ));
      return;
    }
    const S = r;
    if (S === "v1" && g.version === Pe && g.type === "request") {
      dn(e, S, g.operation, g.id, "unsupported-version", "Protocol version v2 is not available in this session.");
      return;
    }
    if (S === void 0 || g.version !== S) {
      e.destroy();
      return;
    }
    if (g.type === "cancel") {
      const u = o.removeExternal(g.id);
      if (u) {
        i.delete(u), Bo(u);
        const p = a.get(u);
        p?.abort(), p && At.delete(p), a.delete(u);
        const A = { requestId: u, rendererGeneration: lt };
        Zr(ke.revokeRequest(A).finally(() => {
          vs(u, "Desktop host request cancelled.");
        }));
      }
      return;
    }
    if (g.type !== "request" || o.getInternal(g.id)) {
      e.destroy();
      return;
    }
    if (!go().includes(g.operation)) {
      dn(e, S, g.operation, g.id, "unavailable", "The requested desktop operation is unavailable on this platform.");
      return;
    }
    const _ = o.create(g.id), H = new AbortController();
    At.add(H), a.set(_, H);
    const q = { requestId: _, rendererGeneration: lt };
    rx(g.operation, g.input, q, H.signal).then((u) => {
      if (H.signal.throwIfAborted(), g.operation === "host.export.run") {
        const p = Pt.parse(u);
        !p.canceled && !p.preflightOnly && i.add(_);
      }
      return Ga(g.operation, u, _, g.deadlineMs, n);
    }).then(async (u) => {
      if (a.delete(_), At.delete(H), i.delete(_), g.operation === "host.export.run" && !u.error) {
        const A = vl.safeParse(u.result);
        A.success && A.data.status === "queued" && A.data.jobId && (Zt.set(A.data.jobId, q), Vo.delete(A.data.jobId) && (Zt.delete(A.data.jobId), await ke.revokeRequest(q)));
      }
      const p = o.getExternal(_);
      if (!p) {
        (g.operation !== "host.export.run" || ![...Zt.values()].some((A) => A.requestId === q.requestId && A.rendererGeneration === q.rendererGeneration)) && await ke.revokeRequest(q);
        return;
      }
      if (o.removeExternal(p), e.destroyed) {
        (g.operation !== "host.export.run" || ![...Zt.values()].some((A) => A.requestId === q.requestId && A.rendererGeneration === q.rendererGeneration)) && await ke.revokeRequest(q);
        return;
      }
      (g.operation === "host.import.audio" || g.operation === "host.export.run" && !JS(q)) && await ke.revokeRequest(q);
      try {
        const A = ex(
          g.operation,
          u.error,
          S
        );
        for (const C of ew(
          g.operation,
          g.input,
          { ...u, error: A, id: p, version: S },
          S
        ))
          e.write(qr(C));
      } catch {
        dn(e, S, g.operation, p, "internal", "The desktop response could not be serialized.");
      }
    }).catch(async (u) => {
      a.delete(_), At.delete(H), i.delete(_), await ke.revokeRequest(q);
      const p = o.getExternal(_);
      if (!p) return;
      o.removeExternal(p);
      const A = u instanceof Error && u.message === "Renderer deadline exceeded." ? "The request deadline elapsed." : "The renderer is unavailable.", C = u instanceof Error && u.message === "Renderer deadline exceeded." ? "deadline-exceeded" : "unavailable";
      dn(e, S, g.operation, p, C, A);
    });
  });
  e.on("data", (g) => {
    try {
      h(g);
    } catch {
      e.destroy();
    }
  }), e.on("close", m), e.on("error", m);
}, cx = () => {
  de.on(GS, (u, p) => {
    if (!X || u.sender.id !== X.webContents.id || !u.senderFrame || !et(u.senderFrame.url) || typeof p != "object" || p === null || !("generation" in p) || !("frame" in p)) return;
    const A = p.generation;
    if (typeof A != "number" || !Number.isSafeInteger(A) || A !== lt) return;
    const C = Pl.safeParse(p.frame);
    if (!C.success) return;
    if (C.data.type === "export-terminal") {
      const K = Zt.get(C.data.jobId);
      K ? (Zt.delete(C.data.jobId), Zr(ke.revokeRequest(K))) : Vo.size < 1024 && Vo.add(C.data.jobId);
      return;
    }
    if (C.data.type !== "reply") return;
    const L = vt.get(C.data.id);
    !L || L.generation !== A || L.resolve(C.data);
  });
  const e = (u, p) => {
    if (!(!X || u.sender.id !== X.webContents.id || !u.senderFrame || !et(u.senderFrame.url)) && !(typeof p != "object" || p === null || !("requestId" in p) || typeof p.requestId != "string"))
      return { requestId: p.requestId, rendererGeneration: lt };
  }, t = (u) => process.platform === "darwin" && X !== void 0 && u.sender.id === X.webContents.id && u.senderFrame !== null && et(u.senderFrame.url) && ar !== void 0, r = (u) => ({ ok: !1, error: u }), n = (u) => t(u) ? ar : void 0, o = (u) => process.platform === "darwin" && process.arch === "arm64" && X !== void 0 && u.sender.id === X.webContents.id && u.senderFrame !== null && et(u.senderFrame.url);
  de.handle("daw:audio-host:diagnostics", async (u) => {
    if (!o(u) || !Se)
      return {
        ok: !1,
        error: "The native audio host is unavailable.",
        artifactVerification: jt
      };
    try {
      return {
        ok: !0,
        hello: await Se.start(),
        status: Se.status(),
        diagnostics: await Se.diagnostics(),
        artifactVerification: jt
      };
    } catch {
      return {
        ok: !1,
        error: "The native audio host is unavailable.",
        artifactVerification: jt
      };
    }
  }), de.handle("daw:audio-host:resolve-output-device", async (u, p) => {
    if (!o(u) || !Se || p !== void 0 && typeof p != "string")
      return { ok: !1, error: "The native audio host is unavailable." };
    try {
      return { ok: !0, device: await Se.resolveOutputDevice(p) };
    } catch {
      return { ok: !1, error: "The native audio host is unavailable." };
    }
  }), de.handle("daw:audio-host:resolve-input-device", async (u, p) => {
    if (!o(u) || !Se || p !== void 0 && typeof p != "string")
      return { ok: !1, error: "The native audio host is unavailable." };
    try {
      return { ok: !0, device: await Se.resolveInputDevice(p) };
    } catch {
      return { ok: !1, error: "The native audio host is unavailable." };
    }
  });
  const a = () => ({ ok: !1, error: "The native audio session is unavailable." }), i = (u) => o(u) ? Se : void 0, s = (u) => typeof u == "number" && Number.isSafeInteger(u) && u >= 0 && u <= 4294967295, d = (u) => {
    if (!(typeof u != "object" || u === null || !("deviceId" in u) || typeof u.deviceId != "string" || !("sampleRateHz" in u) || !s(u.sampleRateHz) || !("maxFramesPerBlock" in u) || !s(u.maxFramesPerBlock) || !("channelCount" in u) || !s(u.channelCount) || !("revision" in u) || !s(u.revision)))
      return {
        deviceId: u.deviceId,
        sampleRateHz: u.sampleRateHz,
        maxFramesPerBlock: u.maxFramesPerBlock,
        channelCount: u.channelCount,
        revision: u.revision
      };
  }, m = (u) => {
    if (!(typeof u != "object" || u === null || !("epoch" in u) || !s(u.epoch) || !("running" in u) || typeof u.running != "boolean" || !("frame" in u) || typeof u.frame != "number" || !Number.isSafeInteger(u.frame)))
      return { epoch: u.epoch, running: u.running, frame: u.frame };
  }, h = (u) => {
    if (!(typeof u != "object" || u === null || !Object.keys(u).every((p) => p === "deviceUid" || p === "generation" || p === "sessionId" || p === "channelCount" || p === "inputChannels" || p === "gain" || p === "polarity" || p === "punchStartFrame" || p === "punchEndFrame" || p === "monitoring") || !("deviceUid" in u) || typeof u.deviceUid != "string" || !("generation" in u) || !s(u.generation) || u.generation === 0 || !("sessionId" in u) || typeof u.sessionId != "bigint" || u.sessionId <= 0n || !("channelCount" in u) || u.channelCount !== 1 && u.channelCount !== 2 || !("inputChannels" in u) || !Array.isArray(u.inputChannels) || u.inputChannels.length !== u.channelCount || !u.inputChannels.every(s) || !("gain" in u) || typeof u.gain != "number" || !Number.isFinite(u.gain) || u.gain < 0 || !("polarity" in u) || u.polarity !== 1 && u.polarity !== -1 || !("punchStartFrame" in u) || typeof u.punchStartFrame != "number" || !Number.isSafeInteger(u.punchStartFrame) || u.punchStartFrame < 0 || !("punchEndFrame" in u) || u.punchEndFrame !== null && (typeof u.punchEndFrame != "number" || !Number.isSafeInteger(u.punchEndFrame) || u.punchEndFrame < u.punchStartFrame) || !("monitoring" in u) || typeof u.monitoring != "boolean"))
      return {
        deviceUid: u.deviceUid,
        generation: u.generation,
        sessionId: u.sessionId,
        channelCount: u.channelCount,
        inputChannels: u.inputChannels,
        gain: u.gain,
        polarity: u.polarity,
        punchStartFrame: u.punchStartFrame,
        punchEndFrame: u.punchEndFrame,
        monitoring: u.monitoring
      };
  }, g = (u) => {
    if (!(typeof u != "object" || u === null || !Object.keys(u).every((p) => p === "sessionAssetId" || p === "frameCount" || p === "sampleRateHz" || p === "channelCount" || p === "planarPcm" || p === "contentHashPrefix") || !("sessionAssetId" in u) || !s(u.sessionAssetId) || !("frameCount" in u) || !s(u.frameCount) || !("sampleRateHz" in u) || !s(u.sampleRateHz) || !("channelCount" in u) || !s(u.channelCount) || !("planarPcm" in u) || !(u.planarPcm instanceof Uint8Array) || "contentHashPrefix" in u && u.contentHashPrefix !== void 0 && !(u.contentHashPrefix instanceof Uint8Array)))
      return {
        sessionAssetId: u.sessionAssetId,
        frameCount: u.frameCount,
        sampleRateHz: u.sampleRateHz,
        channelCount: u.channelCount,
        planarPcm: u.planarPcm,
        ..."contentHashPrefix" in u && u.contentHashPrefix instanceof Uint8Array ? { contentHashPrefix: u.contentHashPrefix } : {}
      };
  }, S = (u) => u instanceof Uint8Array ? u : void 0, _ = (u, p) => {
    if (typeof p != "object" || p === null) return null;
    if (!("anchor" in p)) return;
    if (typeof p.anchor != "object" || p.anchor === null || !("x" in p.anchor) || !("y" in p.anchor) || typeof p.anchor.x != "number" || typeof p.anchor.y != "number" || !Number.isFinite(p.anchor.x) || !Number.isFinite(p.anchor.y) || Math.abs(p.anchor.x) > 8e6 || Math.abs(p.anchor.y) > 8e6) return null;
    const A = ws.fromWebContents(u.sender);
    if (!A) return null;
    const C = A.getContentBounds(), L = u.sender.getZoomFactor(), K = Math.round(C.x + p.anchor.x * L), Ce = Math.round(C.y + p.anchor.y * L);
    return !Number.isSafeInteger(K) || !Number.isSafeInteger(Ce) || K < -2147483648 || K > 2147483647 || Ce < -2147483648 || Ce > 2147483647 ? null : { x: K, y: Ce };
  };
  de.handle("daw:audio-host:session:configure", async (u, p) => {
    const A = i(u), C = d(p);
    if (!A || !C) return a();
    try {
      return await A.configure(C), { ok: !0 };
    } catch {
      return a();
    }
  }), de.handle("daw:audio-host:session:install-asset", async (u, p) => {
    const A = i(u), C = g(p);
    if (!A || !C) return a();
    try {
      return await A.installAsset(C), { ok: !0 };
    } catch {
      return a();
    }
  }), de.handle("daw:audio-host:session:release-asset", async (u, p) => {
    const A = i(u);
    if (!A || !s(p) || p === 0) return a();
    try {
      return await A.releaseAsset(p), { ok: !0 };
    } catch {
      return a();
    }
  }), de.handle("daw:audio-host:session:detach-vst", async (u, p) => {
    const A = i(u);
    if (!A || typeof p != "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p))
      return a();
    try {
      return await A.detachVst(p), { ok: !0 };
    } catch {
      return a();
    }
  }), de.handle("daw:audio-host:session:editor", async (u, p) => {
    const A = o(u), C = A && Se?.status().running ? Se : void 0, L = A ? Ka : void 0, K = typeof p == "object" && p !== null && "command" in p && (p.command === "open" || p.command === "close" || p.command === "focus" || p.command === "resize" || p.command === "status") ? p.command : "invalid";
    if (console.info("[native-vst3] editor command entry", {
      command: K,
      activeHostAvailable: !!C,
      managerAvailable: !!L
    }), !L && !C || typeof p != "object" || p === null || !("instanceId" in p) || typeof p.instanceId != "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.instanceId) || !("command" in p) || p.command !== "open" && p.command !== "close" && p.command !== "focus" && p.command !== "resize" && p.command !== "status" || "width" in p && (typeof p.width != "number" || !s(p.width) || p.width > 8192) || "height" in p && (typeof p.height != "number" || !s(p.height) || p.height > 8192) || "anchor" in p && p.command !== "open" && p.command !== "focus" || "serializedPlan" in p && (typeof p.serializedPlan != "string" || Buffer.byteLength(p.serializedPlan, "utf8") > 1048576) || (p.command === "open" || p.command === "focus" || p.command === "status") && (!("serializedPlan" in p) || typeof p.serializedPlan != "string"))
      return console.info("[native-vst3] editor command result", { route: "error" }), { ok: !1, error: "The native VST editor command is invalid." };
    const Ce = _(u, p);
    if (Ce === null)
      return console.info("[native-vst3] editor command result", { route: "error" }), { ok: !1, error: "The native VST editor command is invalid." };
    try {
      const qe = p.command, He = {
        instanceId: p.instanceId,
        command: qe,
        ..."serializedPlan" in p && typeof p.serializedPlan == "string" ? { serializedPlan: p.serializedPlan } : {},
        ..."width" in p && typeof p.width == "number" ? { width: p.width } : {},
        ..."height" in p && typeof p.height == "number" ? { height: p.height } : {},
        ...Ce === void 0 ? {} : { anchor: Ce }
      };
      if (C)
        try {
          const Qe = await C.executeVstEditorCommand({
            ...He,
            command: "status"
          });
          if (Qe.supported || (await C.diagnostics().catch(() => {
          }))?.state === "running") {
            const oe = He.command === "status" ? Qe : await C.executeVstEditorCommand(He);
            if (console.info("[native-vst3] editor command result", {
              route: "active",
              success: oe.success
            }), oe.success || He.command !== "close") return { ok: !0, status: oe };
          }
        } catch (Qe) {
          console.error("[native-vst3] editor active route failed", {
            error: fo(Qe)
          });
          const Be = await C.diagnostics().catch(() => {
          });
          if (Be?.state === "running" || !L) throw Qe;
          console.info("[native-vst3] editor active route falling back to isolated", {
            command: He.command,
            diagnosticsState: Be?.state ?? "unavailable"
          });
        }
      if (!L)
        return console.info("[native-vst3] editor command result", { route: "error" }), { ok: !1, error: "The isolated native VST editor session is unavailable." };
      const Jt = await L.execute(He);
      return console.info("[native-vst3] editor command result", { route: "isolated" }), { ok: !0, status: Jt };
    } catch (qe) {
      return console.error("[native-vst3] editor command failed", {
        error: fo(qe)
      }), console.info("[native-vst3] editor command result", { route: "error" }), { ok: !1, error: fo(qe) };
    }
  }), de.handle("daw:audio-host:session:coordinate-vst-attachments", async (u, p) => {
    const A = i(u), C = Ht;
    if (!A || !ar || !C || typeof p != "object" || p === null || !("serializedPlan" in p) || typeof p.serializedPlan != "string" || Buffer.byteLength(p.serializedPlan, "utf8") > 1048576 || !("sampleRateHz" in p) || typeof p.sampleRateHz != "number" || !Number.isFinite(p.sampleRateHz) || p.sampleRateHz <= 0 || p.sampleRateHz > 384e3) return a();
    const L = await Hl({
      serializedPlan: p.serializedPlan,
      sampleRateHz: p.sampleRateHz,
      workerPath: C,
      catalogStore: ar,
      audioHost: A
    });
    return L.ok ? { ok: !0 } : { ok: !1, error: L.message };
  });
  const H = (u, p) => de.handle(u, async (A, C) => {
    const L = i(A), K = S(C);
    if (!L || !K) return a();
    try {
      return await p(L, K), { ok: !0 };
    } catch {
      return a();
    }
  });
  H("daw:audio-host:session:publish-graph", (u, p) => u.publishGraph(p)), H("daw:audio-host:session:queue-parameter-events", (u, p) => u.queueParameterEvents(p)), H("daw:audio-host:session:queue-vst-parameter-events", (u, p) => u.queueVstParameterEvents(p)), H("daw:audio-host:session:queue-instrument-events", (u, p) => u.queueInstrumentEvents(p)), H("daw:audio-host:session:queue-source-events", (u, p) => u.queueSourceEvents(p)), de.handle("daw:audio-host:session:set-transport", async (u, p) => {
    const A = i(u), C = m(p);
    if (!A || !C) return a();
    try {
      return await A.setTransport(C), { ok: !0 };
    } catch {
      return a();
    }
  }), de.handle("daw:audio-host:session:configure-recording", async (u, p) => {
    const A = i(u), C = h(p);
    if (!A || !C) return a();
    try {
      return await A.configureRecording(C), { ok: !0 };
    } catch {
      return a();
    }
  }), de.handle("daw:audio-host:session:stop-recording", async (u, p) => {
    const A = i(u);
    if (!A || p !== void 0 && (typeof p != "number" || !Number.isSafeInteger(p) || p < 0)) return a();
    try {
      return await A.stopRecording(p), { ok: !0 };
    } catch {
      return a();
    }
  });
  const q = (u, p) => de.handle(u, async (A) => {
    const C = i(A);
    if (!C) return a();
    try {
      return await p(C), { ok: !0 };
    } catch {
      return a();
    }
  });
  q("daw:audio-host:session:begin-transaction", (u) => u.beginTransaction()), q("daw:audio-host:session:commit-transaction", (u) => u.commitTransaction()), q("daw:audio-host:session:rollback-transaction", (u) => u.rollbackTransaction()), q("daw:audio-host:session:start", (u) => u.startAudio()), q("daw:audio-host:session:stop", (u) => u.stopAudio()), q("daw:audio-host:session:start-recording", (u) => u.startRecording()), q("daw:audio-host:session:cancel-recording", (u) => u.cancelRecording()), q("daw:audio-host:session:teardown", (u) => u.teardown()), de.handle("daw:plugin-catalog:read", async (u) => {
    const p = n(u);
    if (!p) return r("The desktop plug-in catalog is unavailable.");
    try {
      return { ok: !0, catalog: cn(await p.load()) };
    } catch {
      return r("The plug-in catalog could not be read.");
    }
  }), de.handle("daw:plugin-catalog:choose-directory", async (u) => {
    const p = n(u), A = X;
    if (!p || !A) return r("The desktop plug-in catalog is unavailable.");
    const C = await ln.showOpenDialog(A, { properties: ["openDirectory", "createDirectory"] });
    if (C.canceled || C.filePaths.length !== 1) return { ok: !0, canceled: !0 };
    try {
      return { ok: !0, canceled: !1, catalog: cn(await p.addDirectory(C.filePaths[0])) };
    } catch {
      return r("The selected plug-in directory could not be added.");
    }
  }), de.handle("daw:plugin-catalog:remove-directory", async (u, p) => {
    const A = n(u);
    if (!A) return r("The desktop plug-in catalog is unavailable.");
    if (typeof p != "object" || p === null || !("directory" in p) || typeof p.directory != "string")
      return r("A plug-in directory is required.");
    try {
      return { ok: !0, catalog: cn(await A.removeDirectory(p.directory)) };
    } catch {
      return r("The plug-in directory could not be removed.");
    }
  }), de.handle("daw:plugin-catalog:scan", async (u) => {
    const p = n(u), A = Gl;
    if (!p || !A) return r("The desktop plug-in catalog is unavailable.");
    try {
      const C = await p.load();
      return { ok: !0, catalog: cn(await p.scan((L) => A.scan(L, C.directories))) };
    } catch {
      return r("The plug-in catalog could not be scanned.");
    }
  }), de.handle("daw:plugin-catalog:preflight-insertion", async (u, p) => {
    const A = n(u), C = iI.safeParse(p), L = Ht;
    if (!A || !C.success)
      return { ok: !1, code: "untrusted-catalog", message: "The native VST3 insertion request is invalid." };
    if (!o(u) || !Se || !L)
      return { ok: !1, code: "host-unavailable", message: "The native VST3 host is unavailable." };
    try {
      const K = await Se.resolveOutputDevice();
      return K?.available ? await TI({
        request: C.data,
        catalog: await A.reload(),
        workerPath: L,
        sampleRateHz: K.nominalSampleRateHz
      }) : { ok: !1, code: "host-unavailable", message: "No native audio output device is available." };
    } catch {
      return { ok: !1, code: "host-unavailable", message: "The native VST3 host preflight failed." };
    }
  }), de.handle("daw:capability:readChunk", async (u, p) => {
    const A = e(u, p);
    if (!A || typeof p != "object" || p === null || !("token" in p) || typeof p.token != "string") throw new Error("Invalid capability request.");
    return ke.readFile(A, p.token);
  }), de.handle("daw:capability:beginWrite", async (u, p) => {
    const A = e(u, p);
    if (!A || typeof p != "object" || p === null || !("token" in p) || typeof p.token != "string" || "relativePath" in p && p.relativePath !== void 0 && typeof p.relativePath != "string") throw new Error("Invalid capability request.");
    const C = "relativePath" in p && typeof p.relativePath == "string" ? p.relativePath : void 0;
    return ke.beginWrite(A, p.token, C);
  }), de.handle("daw:capability:writeChunk", async (u, p) => {
    const A = e(u, p);
    if (!A || typeof p != "object" || p === null || !("writerId" in p) || !("offset" in p) || !("chunk" in p) || typeof p.writerId != "string" || typeof p.offset != "number" || !(p.chunk instanceof Uint8Array)) throw new Error("Invalid capability request.");
    return ke.writeChunk(A, p.writerId, p.offset, p.chunk);
  }), de.handle("daw:capability:commit", async (u, p) => {
    const A = e(u, p);
    if (!A || typeof p != "object" || p === null || !("writerId" in p) || typeof p.writerId != "string") throw new Error("Invalid capability request.");
    return ke.commitWrite(A, p.writerId);
  }), de.handle("daw:capability:abort", async (u, p) => {
    const A = e(u, p);
    if (!A || typeof p != "object" || p === null || !("writerId" in p) || typeof p.writerId != "string") throw new Error("Invalid capability request.");
    await ke.abortWrite(A, p.writerId);
  });
}, dx = () => {
  if (!sr(ho))
    throw new Error(`Desktop preload bundle is missing: ${ho}`);
  X = new ws({
    webPreferences: {
      preload: ho,
      contextIsolation: !0,
      nodeIntegration: !1,
      sandbox: !0,
      webSecurity: !0
    }
  }), X.webContents.on("did-start-navigation", () => {
    At.abortAll(), Zr(ke.revokeRendererGeneration(lt)), lt += 1, Fo("Renderer reloaded.");
  }), X.webContents.on("render-process-gone", () => {
    At.abortAll(), Zr(ke.revokeRendererGeneration(lt)), Fo("Renderer crashed.");
  }), X.webContents.setWindowOpenHandler(({ url: t }) => (QS(t) && nu.openExternal(t), { action: "deny" })), X.webContents.on("will-navigate", (t, r) => {
    et(r) || t.preventDefault();
  });
  const e = tw({
    prepare: async () => {
      try {
        const r = (await Ga("lifecycle.prepareToClose", {}, zn(), 1e4)).result;
        return typeof r == "object" && r !== null && "flushed" in r && r.flushed === !0;
      } catch {
        return !1;
      }
    },
    confirmDiscard: async () => (await ln.showMessageBox(X, {
      type: "warning",
      buttons: ["Cancel", "Quit and Discard"],
      defaultId: 0,
      cancelId: 0,
      message: "The project could not finish saving before closing.",
      detail: "Cancel keeps the project open. Quit and Discard closes without waiting for recording finalization or pending writes.",
      noLink: !0
    })).response === 1,
    destroy: () => X?.destroy(),
    finishQuit: No
  });
  X.on("close", (t) => {
    X?.isDestroyed() || Ur || (t.preventDefault(), e());
  }), X.loadURL("daw://app/");
};
ze.setName(Kl);
const No = async () => {
  Ur || (Ur = !0, At.abortAll(), Fo("Application is closing."), await ke.revokeAll(), await Ka?.teardownAll(), await Se?.teardown(), Ql?.(), Jl?.(), Xl?.(), Yl?.(), await nx(), ze.exit());
}, lx = ze.requestSingleInstanceLock();
lx ? (ze.on("second-instance", () => {
  X?.show(), X?.focus();
}), ze.whenReady().then(async () => {
  ja = await eu.selfTest();
  let e;
  if (process.platform === "darwin" && ze.isPackaged) {
    const r = O.join(process.resourcesPath, Ul);
    if (sr(r))
      try {
        const n = await jS(process.resourcesPath);
        e = n.scannerPath, Ht = n.workerPath, tr = n.audioHostPath, jt = { status: "verified" };
      } catch (n) {
        jt = {
          status: "failed",
          reason: n instanceof Error ? n.message : "Native release artifact verification failed."
        };
      }
  } else process.platform === "darwin" && (e = kI(process.resourcesPath, !1, process.env.DAW_VST3_SCANNER_PATH), Ht = _I(process.resourcesPath, !1, process.env.DAW_VST3_WORKER_PATH), tr = VS(process.resourcesPath, !1, process.env.DAW_AUDIO_HOST_PATH), jt = { status: "development" });
  console.info("[native-vst3] native artifact selection", {
    platform: process.platform,
    isPackaged: ze.isPackaged,
    verificationStatus: jt.status,
    scannerPathAvailable: !!e,
    workerPathAvailable: !!Ht,
    audioHostPathAvailable: !!tr
  }), Gl = e ? PI({
    platform: process.platform,
    arch: process.arch,
    scannerPath: e
  }) : void 0, ar = $w({
    filePath: O.join(ze.getPath("userData"), "plugin-catalog-v1.json")
  }), Se = tr ? fs(tr) : void 0, Yl = Se?.onWorkerNotification((r) => {
    console.info("[native-vst3] worker notification", {
      kind: r.kind,
      graphRevision: r.graphRevision,
      value: r.value
    });
  });
  const t = tr;
  Ka = t && Ht ? FS({
    workerPath: Ht,
    catalogStore: ar,
    createSupervisor: () => fs(t),
    onEditorInteraction: () => {
      const r = X;
      !r || r.isDestroyed() || Ur || (r.show(), ze.focus({ steal: !0 }), r.focus());
    }
  }) : void 0, Ql = Se?.onLoss(() => {
    const r = X?.webContents;
    r && !r.isDestroyed() && et(r.getURL()) && r.send("daw:audio-host:loss");
  }), Jl = Se?.onRecordingBlock((r) => {
    const n = X?.webContents;
    n && !n.isDestroyed() && et(n.getURL()) && n.send("daw:audio-host:recording-block", r);
  }), Xl = Se?.onRecordingStatus((r) => {
    const n = X?.webContents;
    n && !n.isDestroyed() && et(n.getURL()) && n.send("daw:audio-host:recording-status", r);
  }), ks.handle("daw", (r) => {
    const n = KS(ze.getAppPath()), o = WS(n, r.url);
    return !o || !sr(o) ? new Response("Not found", { status: 404 }) : ru.fetch(du(o).toString());
  }), Yn.defaultSession.webRequest.onHeadersReceived((r, n) => n({
    responseHeaders: {
      ...r.responseHeaders,
      "Content-Security-Policy": [Ew(!1)]
    }
  })), Yn.defaultSession.setPermissionRequestHandler((r, n, o, a) => o(
    ys({
      permission: n,
      requestingUrl: r.getURL(),
      mediaTypes: "mediaTypes" in a ? a.mediaTypes : void 0
    }) || bs({
      permission: n,
      trustedRendererId: X?.webContents.id,
      requestingRendererId: r.id,
      requestingUrl: a.requestingUrl,
      isMainFrame: a.isMainFrame
    })
  )), Yn.defaultSession.setPermissionCheckHandler((r, n, o, a) => r !== null && ys({
    permission: n,
    requestingUrl: o,
    mediaTypes: a.mediaType === "audio" ? ["audio"] : void 0
  }) || bs({
    permission: n,
    trustedRendererId: X?.webContents.id,
    requestingRendererId: r?.id,
    requestingUrl: o,
    isMainFrame: a.isMainFrame
  })), cx(), await ix(), dx();
}).catch(() => ze.quit()), ze.on("before-quit", (e) => {
  Ur || (e.preventDefault(), X && !X.isDestroyed() ? X.close() : No());
}), ze.on("window-all-closed", () => void No())) : ze.quit();
