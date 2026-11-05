import contract from './runner-contract.json' with {type: 'json'};

/** Shared with the exported helper without loading server contract services. */
export const AGENT_NAME_SCHEMA = contract.$defs.AgentName;
const namePattern = new RegExp(AGENT_NAME_SCHEMA.pattern, 'u');

export function isValidAgentName(value: unknown): value is string {
  return typeof value === 'string' && value === value.normalize('NFC') &&
    [...value].length >= AGENT_NAME_SCHEMA.minLength && [...value].length <= AGENT_NAME_SCHEMA.maxLength && namePattern.test(value);
}
