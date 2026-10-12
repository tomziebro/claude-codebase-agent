import type { ToolDefinition } from "../anthropic/types.js";
import type { Workspace } from "./workspace.js";

export interface Tool<Input = Record<string, unknown>> {
  definition: ToolDefinition;
  parse(input: Record<string, unknown>): Input;
  run(input: Input, workspace: Workspace): Promise<string>;
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolInputError(`"${key}" must be a string.`);
  return value;
}

export function requiredString(input: Record<string, unknown>, key: string): string {
  const value = optionalString(input, key);
  if (value === undefined || value === "") throw new ToolInputError(`"${key}" is required.`);
  return value;
}

export function optionalInt(
  input: Record<string, unknown>,
  key: string,
  { min, max }: { min: number; max: number },
): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ToolInputError(`"${key}" must be an integer.`);
  }
  if (value < min || value > max) {
    throw new ToolInputError(`"${key}" must be between ${min} and ${max}.`);
  }
  return value;
}

export function optionalBool(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ToolInputError(`"${key}" must be a boolean.`);
  return value;
}
