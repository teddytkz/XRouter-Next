"use client";

// ponytail: vanilla <input type=range> with label + value display. Upgrade to a
// real slider with tooltip + debounce when ECC auto-skill-router gets more than
// 3 fields.
export default function ConfigSlider({
  label,
  value,
  min = 0,
  max = 1,
  step = 0.05,
  onChange,
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{Number(value).toFixed(step < 1 ? 2 : 0)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange?.(Number(e.target.value))}
        className="w-full accent-primary"
      />
    </div>
  );
}
