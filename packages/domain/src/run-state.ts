import { z } from 'zod';

export const RunStateSchema = z.enum([
  'queued',
  'running',
  'waiting_input',
  'waiting_approval',
  'waiting_external',
  'verifying',
  'succeeded',
  'failed',
  'cancelled',
  'outcome_unknown',
]);

export type RunState = z.infer<typeof RunStateSchema>;

export const TERMINAL_RUN_STATES: readonly RunState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'outcome_unknown',
] as const;

export const WAITING_RUN_STATES: readonly RunState[] = [
  'waiting_input',
  'waiting_approval',
  'waiting_external',
] as const;

export function isTerminalRunState(state: RunState): boolean {
  return (TERMINAL_RUN_STATES as readonly string[]).includes(state);
}

export function isWaitingRunState(state: RunState): boolean {
  return (WAITING_RUN_STATES as readonly string[]).includes(state);
}
