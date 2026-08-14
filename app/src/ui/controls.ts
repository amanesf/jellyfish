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
  /** Both of the above are fixed, and `?flow=` / `?light=` still move them for
   * scripts/capture.js — the measure loop drives the water through this. */
  /** Whether the lamp is walking the wheel on its own. When it is not, the
   * lamp is white and the picture is the one the ramps were measured at. */
  ledAuto: () => boolean;
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

/**
 * Fixed, and no longer on the console.
 *
 * 水流 and 水の色 were dials for settings that have one good answer each, and
 * every extra row pushed the 色送り button further off the bottom of a phone
 * screen. A console is not an inventory of everything the renderer can do — it
 * is the two or three things worth changing while you watch. `?flow=` and
 * `?light=` still set them, which is how scripts/capture.js measures the water.
 */
const FIXED: Record<string, number> = { flow: 0.5, light: 1 };

const SLIDERS: SliderSpec[] = [
  { key: 'count', label: '個体数', min: 2, max: 30, step: 1, value: 15, format: (v) => `${v}体` },
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

  // The lamp.
  //
  // A public tank's LEDs are not parked on a colour, they crawl round the wheel
  // over a couple of minutes, and half of what is hypnotic about standing in
  // front of one is that the animals are a different colour than they were when
  // you looked away. So the lamp is a switch and not a dial: there was a 照明色
  // slider beside it and it was the fifth row on a console that has room for
  // four, pushing the button itself off the bottom of a phone screen. Off is
  // white, which is the picture the ramps were measured at.
  let auto = new URLSearchParams(window.location.search).get('auto') === '1';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'toggle';
  const paint = () => {
    button.textContent = auto ? '自動 ON' : '自動 OFF';
    button.setAttribute('aria-pressed', String(auto));
    button.classList.toggle('on', auto);
  };
  button.addEventListener('click', () => { auto = !auto; paint(); });
  paint();
  const autoRow = document.createElement('div');
  autoRow.className = 'row';
  const autoLabel = document.createElement('span');
  autoLabel.textContent = '色送り';
  autoRow.append(autoLabel, button, document.createElement('span'));
  host.appendChild(autoRow);

  for (const [key, value] of Object.entries(FIXED)) {
    const override = new URLSearchParams(window.location.search).get(key);
    values.set(key, override !== null ? Number(override) : value);
  }

  const get = (key: string) => values.get(key)!;
  return {
    count: () => get('count'),
    flow: () => get('flow'),
    light: () => get('light'),
    ledAuto: () => auto,
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
