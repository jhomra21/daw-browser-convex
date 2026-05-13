1. Keep JSX minimal

Avoid unnecessary wrappers when the parent already defines styling.

Instead of
<DropdownMenuItem onSelect={() => patchRowState({ rotate: true })}>
  <span class="text-xs">Rotate</span>
</DropdownMenuItem>

Do

<DropdownMenuItem onSelect={() => patchRowState({ rotate: true })}>
  Rotate
</DropdownMenuItem>Let the component control typography.

2. Don’t use arbitrary bracket values

Values like [#9a9ca3], [10px], [2px], etc. should not appear in code.
Use Tailwind tokens or extend our design tokens if something is missing.

Instead of

<div class="text-[#9a9ca3] group-hover:text-foreground" />

Do

<div class="text-muted-foreground group-hover:text-foreground" />

If a token doesn’t exist yet, we add it globally, not inline.

3. Minimize component props

Prefer passing a single object and letting the component handle logic internally.

Instead of

<AnchorRow
  anchorX={() => props.node()?.anchor.x ?? 0.5}
  anchorY={() => props.node()?.anchor.y ?? 0.5}
  setAnchorX={(value) => assignValues({ 'anchor.x': value })}
  setAnchorY={(value) => assignValues({ 'anchor.y': value })}
  onSelectPoint={(x, y) => assignValues({ 'anchor.x': x, 'anchor.y': y })}
  onReset={() => assignValues({ 'anchor.x': 0.5, 'anchor.y': 0.5 })}
  onRemove={() => setAddons({ ...addons(), anchor: false })}
/>

Do

<AnchorRow node={props.node} />

This keeps APIs maintainable and easier to reason about.

4. Reduce custom sizing utilities

Use semantic Tailwind utilities instead of pixel definitions.

Instead of
class="w-[2px] h-[2px] rounded-[2px] bg-muted-foreground"

Do
class="size-0.5 rounded-full bg-muted-foreground"

Same result, but aligned with the system.

5. Typography must use tokens

Instead of

<span class="text-[10px] leading-[14px] tracking-[0.036px] text-primary-foreground">
  {props.item.duration}
</span>

Do something like

<span class="text-xxs text-primary-foreground">
  {props.item.duration}
</span>

If we truly need a new text style, we define a token for it.

6. Use cn for class merging

Avoid manual string concatenation.

Instead of

class={`bg-background rounded-xl overflow-hidden shadow-lg border border-border ${props.containerClass ?? ""}`}

Do

class={cn(
  "bg-background rounded-xl overflow-hidden shadow-lg border border-border",
  props.containerClass
)}

7. Avoid nested JSX component declarations

Instead of

function A() {
  const B = () => <div />;

  return <div><B /></div>;
}

Do

function B() {
  return <div />;
}

function A() {
  return <div><B /></div>;
}

This prevents unnecessary re-creation and keeps structure clearer.

8. Prefer classList for conditionals

Instead of
class={props.disabled ? "opacity-50" : undefined}

Do
classList={{ "opacity-50": props.disabled }}

More declarative and easier to extend.
