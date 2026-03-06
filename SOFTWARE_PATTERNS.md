## Software Engineering Patterns

Optimization patterns focused on developer experience (DX), code clarity, and maintainability.

---

### 1. Syntactic Sugar

Making existing functionality nicer to write and read without adding new capabilities.
The underlying behavior is identical; only the surface syntax changes.

**Real-world examples**:
| Domain | Example |
|--------|---------|
| JavaScript | `async/await` is sugar over Promises |
| CSS | `margin: 10px` is sugar for margin-top/right/bottom/left |
| React | `useState` is sugar over `useReducer` |
| TypeScript | `readonly` is sugar for getter-only properties |
| Shell | `ll` alias is sugar for `ls -la` |

---

### 2. API Ergonomics

Designing interfaces that are comfortable to use.

**Characteristics of ergonomic APIs**:

- Fewer variables to manage (one instead of two)
- Consistent mental model (same function, different arity)
- Cleaner object shapes: `{ x: signal(), y: signal() }` vs `{ x, setX, y, setY }`
- Reduced cognitive load

---

### 3. DRY (Don't Repeat Yourself)

Eliminating repetitive patterns by extracting common logic.

---

### 4. Abstraction / Encapsulation

Hiding implementation details behind a simpler interface.

---

### 5. Classification Reference

| Term                     | Applies?     | Why                                         |
| ------------------------ | ------------ | ------------------------------------------- |
| Syntactic sugar          | ✅ Yes       | Same behavior, sweeter syntax               |
| API ergonomics           | ✅ Yes       | More comfortable to use                     |
| Boilerplate reduction    | ✅ Yes       | Eliminates repetitive setup code            |
| DRY                      | ✅ Yes       | Extract repeated patterns                   |
| Abstraction              | ✅ Yes       | Hide complexity behind simple interface     |
| Facade pattern           | ✅ Partially | Simplified interface over complex subsystem |
| Utility function         | ✅ Yes       | Reusable helper for common task             |
| Wrapper                  | ✅ Yes       | Wraps existing API with different interface |
| Performance optimization | ❌ No        | No runtime improvement, just DX             |

---

### 6. What These Patterns Are NOT

- **Not performance optimizations** — same runtime behavior
- **Not new capabilities** — underlying functionality already existed
- **Not Gang of Four design patterns** — convenience utilities, not architectural patterns

---

### 7. When to Apply

**Extract when you see**:

- Verbose setup code that obscures intent
- Multiple variables that logically belong together
- Complex APIs that could be simplified for common use cases

**Don't extract when**:

- One-off code that won't be reused
- Trivial patterns (< 5 lines)
- Abstraction would require many parameters (sign of over-abstraction)
- Explicitness is more valuable than brevity
