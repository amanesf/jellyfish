/**
 * The console (plan.md §6).
 *
 * Continuous knobs, no presets. sakura dropped its two named skies for exactly
 * this reason: naming two points on an axis hides that everything between them
 * is also worth looking at.
 *
 * Nothing here is floated over the picture — the picture is a band and the
 * strip under it belongs to the controls, so they never cover the tank and
 * never have to fade.
 */
export interface Controls {
  /** How many animals are in the tank, 2 (sparse) .. 20 (a bloom). */
  count: () => number;
  /** 0 (still) .. 1 (stirred). Drives the flow field and the shafts. */
  flow: () => number;
  /** The water's colour, 0 (indigo) .. 0.5 (as measured) .. 1 (green-teal).
   * Not a brightness — see scene/water.ts. */
  light: () => number;
  /** Playback rate, 1-8x. */
  timeScale: () => number;
  /** Move a knob from code, as the capture harness does. */
  setValue: (key: string, value: number) => void;
}

interface SliderSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
}

const SLIDERS: SliderSpec[] = [
  { key: 'count', label: '個体数', min: 2, max: 20, step: 1, value: 8, format: (v) => `${v}体` },
  { key: 'flow', label: '水流', min: 0, max: 1, step: 0.01, value: 0, format: (v) => v.toFixed(2) },
  { key: 'light', label: '水の色', min: 0, max: 1, step: 0.01, value: 0.5, format: (v) => v.toFixed(2) },
  { key: 'speed', label: '倍速', min: 1, max: 8, step: 0.5, value: 1, format: (v) => `${v}x` },
];

export function createControls(host: HTMLElement): Controls {
  const values = new Map<string, number>();
  const inputs = new Map<string, HTMLInputElement>();
  const readouts = new Map<string, HTMLElement>();

  for (const spec of SLIDERS) {
    const stored = new URLSearchParams(window.location.search).get(spec.key);
    const initial = stored !== null ? Number(stored) : spec.value;
    values.set(spec.key, initial);

    const row = document.createElement('label');
    row.className = 'row';
    const label = document.createElement('span');
    label.textContent = spec.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(initial);
    const readout = document.createElement('span');
    readout.className = 'value';
    readout.textContent = spec.format(initial);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      values.set(spec.key, v);
      readout.textContent = spec.format(v);
    });
    row.append(label, input, readout);
    host.appendChild(row);
    inputs.set(spec.key, input);
    readouts.set(spec.key, readout);
  }

  const get = (key: string) => values.get(key)!;
  return {
    count: () => get('count'),
    flow: () => get('flow'),
    light: () => get('light'),
    timeScale: () => get('speed'),
    setValue(key, value) {
      const input = inputs.get(key);
      const spec = SLIDERS.find((s) => s.key === key);
      if (!input || !spec) return;
      values.set(key, value);
      input.value = String(value);
      readouts.get(key)!.textContent = spec.format(value);
    },
  };
}
