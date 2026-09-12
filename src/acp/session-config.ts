import { EFFORTS, type EffortLevel } from "../agent/effort";
import { PERSONALITIES, type PersonalityId } from "../agent/personalities";
import { PERSONAS, type PersonaId } from "../agent/personas";
import { ROUTE_MODES, type RouteMode } from "../agent/route-modes";
import type { ModelChoice } from "../agent/selector";
import type { Catalog } from "../providers/catalog";

export interface AcpSessionConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: "select";
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}

export interface AcpSessionSettings {
  active: ModelChoice;
  persona: PersonaId;
  personality: PersonalityId;
  effort: EffortLevel;
  route: RouteMode;
  maxToolLoops: number;
}

export interface ActiveAcpSessionHolder {
  current: string | null;
}

export interface AcpSessionConfigController {
  ensure(sessionId: string): AcpSessionSettings;
  current(): AcpSessionSettings;
  options(sessionId: string): AcpSessionConfigOption[];
  set(sessionId: string, configId: string, value: unknown): AcpSessionConfigOption[];
}

function selectOption(input: {
  id: string;
  name: string;
  description: string;
  category?: string;
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}): AcpSessionConfigOption {
  return { type: "select", ...input };
}

/** Per-session selectors advertised through ACP's stable `configOptions` surface. Runtime
 * closures read `holder.current`, preserving independent settings while the ACP connection's
 * existing single-in-flight-turn invariant is in force. */
export function createAcpSessionConfig(input: {
  defaults: AcpSessionSettings;
  catalog: Catalog;
  routingTiersAvailable: boolean;
  holder: ActiveAcpSessionHolder;
  /** Fire-and-forget hook for provider/model changes (for example, context-window priming). */
  onActiveChange?: (choice: ModelChoice) => void;
}): AcpSessionConfigController {
  const states = new Map<string, AcpSessionSettings>();
  const availableProviders = input.catalog.filter((entry) => entry.models.length > 0);
  const cloneDefaults = (): AcpSessionSettings => ({
    ...input.defaults,
    active: { ...input.defaults.active },
  });
  const ensure = (sessionId: string): AcpSessionSettings => {
    const existing = states.get(sessionId);
    if (existing) return existing;
    const state = cloneDefaults();
    states.set(sessionId, state);
    return state;
  };
  const current = (): AcpSessionSettings =>
    input.holder.current ? ensure(input.holder.current) : input.defaults;

  const options = (sessionId: string): AcpSessionConfigOption[] => {
    const state = ensure(sessionId);
    const provider = input.catalog.find((entry) => entry.provider === state.active.provider);
    const routes = input.routingTiersAvailable
      ? ROUTE_MODES
      : ROUTE_MODES.filter((route) => route.id === "manual");
    return [
      selectOption({
        id: "provider",
        name: "Provider",
        description: "Model provider for manual routing",
        category: "_provider",
        currentValue: state.active.provider,
        options: availableProviders.map((entry) => ({
          value: entry.provider,
          name: entry.provider,
        })),
      }),
      selectOption({
        id: "model",
        name: "Model",
        description: "Active model for manual routing",
        category: "model",
        currentValue: state.active.model,
        options: (provider?.models ?? []).map((model) => ({ value: model, name: model })),
      }),
      selectOption({
        id: "persona",
        name: "Persona",
        description: "System role and working style",
        category: "_persona",
        currentValue: state.persona,
        options: PERSONAS.map((persona) => ({
          value: persona.id,
          name: persona.id,
          description: persona.description,
        })),
      }),
      selectOption({
        id: "personality",
        name: "Personality",
        description: "Voice overlay for user-facing prose",
        category: "_personality",
        currentValue: state.personality,
        options: PERSONALITIES.map((personality) => ({
          value: personality.id,
          name: personality.id,
          description: personality.description,
        })),
      }),
      selectOption({
        id: "effort",
        name: "Reasoning effort",
        description: "How much reasoning the model should use",
        category: "thought_level",
        currentValue: state.effort,
        options: EFFORTS.map((effort) => ({
          value: effort.id,
          name: effort.id,
          description: effort.description,
        })),
      }),
      selectOption({
        id: "route",
        name: "Routing",
        description: "Model routing strategy",
        category: "_route",
        currentValue: state.route,
        options: routes.map((route) => ({
          value: route.id,
          name: route.id,
          description: route.description,
        })),
      }),
    ];
  };

  return {
    ensure,
    current,
    options,
    set(sessionId, configId, rawValue) {
      if (typeof rawValue !== "string") {
        throw new Error(`configuration '${configId}' requires a string value`);
      }
      const state = ensure(sessionId);
      const available = options(sessionId).find((option) => option.id === configId);
      if (!available) throw new Error(`unknown session configuration '${configId}'`);
      if (!available.options.some((option) => option.value === rawValue)) {
        throw new Error(
          `invalid value '${rawValue}' for '${configId}'. available: ${available.options
            .map((option) => option.value)
            .join(", ")}`,
        );
      }
      switch (configId) {
        case "provider": {
          const selected = input.catalog.find((entry) => entry.provider === rawValue)!;
          state.active = {
            provider: selected.provider,
            model: selected.models.includes(state.active.model)
              ? state.active.model
              : selected.models[0]!,
          };
          input.onActiveChange?.({ ...state.active });
          break;
        }
        case "model":
          state.active = { ...state.active, model: rawValue };
          input.onActiveChange?.({ ...state.active });
          break;
        case "persona":
          state.persona = rawValue as PersonaId;
          break;
        case "personality":
          state.personality = rawValue as PersonalityId;
          break;
        case "effort":
          state.effort = rawValue as EffortLevel;
          break;
        case "route":
          state.route = rawValue as RouteMode;
          break;
      }
      return options(sessionId);
    },
  };
}
