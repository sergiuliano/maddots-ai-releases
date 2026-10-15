/** Review indicators, not a claim that all prompt injection can be recognized. */
export const INJECTION_PHRASES: readonly string[] = Object.freeze([
  'ignore previous instructions',
  'ignore all previous instructions',
  'ignore the previous instructions',
  'disregard previous instructions',
  'disregard all previous instructions',
  'forget previous instructions',
  'override system instructions',
  'ignore system instructions',
  'ignore the system prompt',
  'reveal your system prompt',
  'reveal the system prompt',
  'bypass safety checks',
  'disable safety checks',
]);
