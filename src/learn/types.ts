import type { Skill } from "../skills/types";

export type PlaybookScope = "project" | "global";

export interface LearnedToolStep {
  name: string;
  args: unknown;
  ok: boolean;
  output?: string;
  errorMessage?: string;
  /** Number of adjacent equivalent attempts collapsed into this representative step. */
  repeatCount?: number;
}

export interface LearnableTurn {
  sessionId: string;
  startTs: number;
  endTs: number;
  userInput: string;
  assistantText: string;
  steps: LearnedToolStep[];
  /** Skills automatically injected for this exact source turn, taken from runtime events. */
  invokedSkillNames: string[];
}

export interface PlaybookDraft {
  name: string;
  description: string;
  triggers: string[];
  body: string;
  source: Pick<LearnableTurn, "sessionId" | "startTs" | "endTs" | "userInput">;
}

export interface SavedPlaybook {
  path: string;
  skill: Skill;
  scope: PlaybookScope;
  backupPath?: string;
}
