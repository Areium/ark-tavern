import { emptyInput } from './simulation';
import type { Action, SideviewInput } from './types';

/** Each physical key/pointer owns its hold; releasing one never releases another. */
export function createInputController() {
  const sources = new Map<string, Action>();
  let pending = emptyInput();
  return {
    press(source: string, action: Action) {
      if (sources.has(source)) return;
      sources.set(source, action);
      pending[action] = true;
    },
    release(source: string) { sources.delete(source); },
    releasePrefix(prefix: string) {
      for (const source of sources.keys()) if (source.startsWith(prefix)) sources.delete(source);
    },
    sample(gamepad?: SideviewInput): SideviewInput {
      const sampled = { ...pending };
      for (const action of sources.values()) sampled[action] = true;
      if (gamepad) for (const action of Object.keys(sampled) as Action[]) sampled[action] ||= gamepad[action];
      pending = emptyInput();
      return sampled;
    },
    clear() { sources.clear(); pending = emptyInput(); },
  };
}

/** Preserve the authored 60Hz camera response at any refresh rate. */
export const cameraEase = (at60Hz: number, seconds: number) => 1 - (1 - at60Hz) ** (Math.max(0, seconds) * 60);
