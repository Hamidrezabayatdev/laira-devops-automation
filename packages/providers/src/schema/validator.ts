/**
 * Strict Typed Schema Validator & Zod Schema Bridge
 * Supports self-contained type-safe validation, OpenAI JSON Schema generation,
 * and direct compatibility with Zod schemas (v3 and v4).
 */

export interface SchemaValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: string[];
}

export interface TypedValidator<T> {
  readonly type: string;
  safeParse(input: unknown): SchemaValidationResult<T>;
  toJsonSchema(): Record<string, unknown>;
}

export class StringValidator implements TypedValidator<string> {
  readonly type = 'string';
  readonly options: { minLength?: number; maxLength?: number; pattern?: RegExp };

  constructor(options: { minLength?: number; maxLength?: number; pattern?: RegExp } = {}) {
    this.options = options;
  }

  safeParse(input: unknown): SchemaValidationResult<string> {
    if (typeof input !== 'string') {
      return { success: false, errors: [`Expected string, received ${typeof input}`] };
    }
    if (this.options.minLength !== undefined && input.length < this.options.minLength) {
      return { success: false, errors: [`String length must be >= ${this.options.minLength}`] };
    }
    if (this.options.maxLength !== undefined && input.length > this.options.maxLength) {
      return { success: false, errors: [`String length must be <= ${this.options.maxLength}`] };
    }
    if (this.options.pattern !== undefined && !this.options.pattern.test(input)) {
      return { success: false, errors: [`String does not match required pattern`] };
    }
    return { success: true, data: input };
  }

  toJsonSchema(): Record<string, unknown> {
    const schema: Record<string, unknown> = { type: 'string' };
    if (this.options.minLength !== undefined) schema.minLength = this.options.minLength;
    if (this.options.maxLength !== undefined) schema.maxLength = this.options.maxLength;
    return schema;
  }
}

export class NumberValidator implements TypedValidator<number> {
  readonly type = 'number';
  readonly options: { min?: number; max?: number; integer?: boolean };

  constructor(options: { min?: number; max?: number; integer?: boolean } = {}) {
    this.options = options;
  }

  safeParse(input: unknown): SchemaValidationResult<number> {
    if (typeof input !== 'number' || Number.isNaN(input)) {
      return { success: false, errors: [`Expected number, received ${typeof input}`] };
    }
    if (this.options.integer && !Number.isInteger(input)) {
      return { success: false, errors: [`Number must be an integer`] };
    }
    if (this.options.min !== undefined && input < this.options.min) {
      return { success: false, errors: [`Number must be >= ${this.options.min}`] };
    }
    if (this.options.max !== undefined && input > this.options.max) {
      return { success: false, errors: [`Number must be <= ${this.options.max}`] };
    }
    return { success: true, data: input };
  }

  toJsonSchema(): Record<string, unknown> {
    const schema: Record<string, unknown> = { type: this.options.integer ? 'integer' : 'number' };
    if (this.options.min !== undefined) schema.minimum = this.options.min;
    if (this.options.max !== undefined) schema.maximum = this.options.max;
    return schema;
  }
}

export class BooleanValidator implements TypedValidator<boolean> {
  readonly type = 'boolean';

  safeParse(input: unknown): SchemaValidationResult<boolean> {
    if (typeof input !== 'boolean') {
      return { success: false, errors: [`Expected boolean, received ${typeof input}`] };
    }
    return { success: true, data: input };
  }

  toJsonSchema(): Record<string, unknown> {
    return { type: 'boolean' };
  }
}

export class EnumValidator<T extends string> implements TypedValidator<T> {
  readonly type = 'string';
  readonly allowedValues: readonly T[];

  constructor(allowedValues: readonly T[]) {
    this.allowedValues = allowedValues;
  }

  safeParse(input: unknown): SchemaValidationResult<T> {
    if (typeof input !== 'string' || !this.allowedValues.includes(input as T)) {
      return {
        success: false,
        errors: [`Expected one of: ${this.allowedValues.join(', ')}, received ${String(input)}`],
      };
    }
    return { success: true, data: input as T };
  }

  toJsonSchema(): Record<string, unknown> {
    return {
      type: 'string',
      enum: [...this.allowedValues],
    };
  }
}

export class OptionalValidator<T> implements TypedValidator<T | undefined> {
  readonly type = 'optional';
  readonly inner: TypedValidator<T>;

  constructor(inner: TypedValidator<T>) {
    this.inner = inner;
  }

  safeParse(input: unknown): SchemaValidationResult<T | undefined> {
    if (input === undefined || input === null) {
      return { success: true, data: undefined };
    }
    return this.inner.safeParse(input);
  }

  toJsonSchema(): Record<string, unknown> {
    return this.inner.toJsonSchema();
  }
}

export class ArrayValidator<T> implements TypedValidator<T[]> {
  readonly type = 'array';
  readonly itemValidator: TypedValidator<T>;

  constructor(itemValidator: TypedValidator<T>) {
    this.itemValidator = itemValidator;
  }

  safeParse(input: unknown): SchemaValidationResult<T[]> {
    if (!Array.isArray(input)) {
      return { success: false, errors: [`Expected array, received ${typeof input}`] };
    }
    const result: T[] = [];
    const errors: string[] = [];

    for (let i = 0; i < input.length; i++) {
      const itemRes = this.itemValidator.safeParse(input[i]);
      if (!itemRes.success) {
        errors.push(`[${i}]: ${(itemRes.errors || []).join('; ')}`);
      } else {
        result.push(itemRes.data as T);
      }
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }
    return { success: true, data: result };
  }

  toJsonSchema(): Record<string, unknown> {
    return {
      type: 'array',
      items: this.itemValidator.toJsonSchema(),
    };
  }
}

export type PropertyShape = Record<string, TypedValidator<unknown>>;

export class ObjectValidator<Shape extends PropertyShape>
  implements TypedValidator<{ [K in keyof Shape]: Shape[K] extends TypedValidator<infer R> ? R : never }>
{
  readonly type = 'object';
  readonly properties: Shape;
  readonly options: { strict?: boolean };

  constructor(properties: Shape, options: { strict?: boolean } = { strict: true }) {
    this.properties = properties;
    this.options = options;
  }

  safeParse(
    input: unknown
  ): SchemaValidationResult<{ [K in keyof Shape]: Shape[K] extends TypedValidator<infer R> ? R : never }> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { success: false, errors: [`Expected object, received ${typeof input}`] };
    }

    const obj = input as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    const errors: string[] = [];

    // Check unknown keys if strict
    if (this.options.strict) {
      for (const key of Object.keys(obj)) {
        if (!(key in this.properties)) {
          errors.push(`Unrecognized key: "${key}"`);
        }
      }
    }

    // Check defined properties
    for (const [key, validator] of Object.entries(this.properties)) {
      const val = obj[key];
      const parsed = validator.safeParse(val);
      if (!parsed.success) {
        errors.push(`Field "${key}": ${(parsed.errors || []).join('; ')}`);
      } else if (parsed.data !== undefined) {
        result[key] = parsed.data;
      }
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }
    return { success: true, data: result as any };
  }

  toJsonSchema(): Record<string, unknown> {
    const props: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, validator] of Object.entries(this.properties)) {
      props[key] = validator.toJsonSchema();
      if (!(validator instanceof OptionalValidator)) {
        required.push(key);
      }
    }

    const schema: Record<string, unknown> = {
      type: 'object',
      properties: props,
      additionalProperties: !this.options.strict,
    };
    if (required.length > 0) {
      schema.required = required;
    }

    return schema;
  }
}

import { zodFunction } from 'openai/helpers/zod';
import { z } from 'zod';

/**
 * Converts a Zod schema object to JSON Schema parameters for OpenAI tool definitions.
 * Uses official OpenAI SDK zod helper with strict validation for actual Zod schemas.
 */
export function zodToJsonSchema(zodSchema: any): Record<string, unknown> {
  if (!zodSchema || typeof zodSchema !== 'object') {
    return { type: 'object', properties: {} };
  }

  // If real Zod schema, use official OpenAI SDK zod helper
  try {
    if (zodSchema instanceof z.ZodType || (zodSchema._def && typeof zodSchema.parse === 'function')) {
      const tool = zodFunction({ name: 'schema', parameters: zodSchema });
      return (tool.function.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>;
    }
  } catch {
    // Fall back to structural extraction if mock or custom object
  }

  // Handle structural / mock ZodObject
  const def = zodSchema._def;
  if (!def) {
    return { type: 'object', properties: {} };
  }

  const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
  if (!shape || typeof shape !== 'object') {
    return { type: 'object', properties: {} };
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, val] of Object.entries(shape as Record<string, any>)) {
    const valDef = val?._def;
    const typeName = valDef?.typeName || valDef?.type || '';

    if (typeName === 'ZodString' || typeName === 'string') {
      properties[key] = { type: 'string' };
    } else if (typeName === 'ZodNumber' || typeName === 'number') {
      properties[key] = { type: 'number' };
    } else if (typeName === 'ZodBoolean' || typeName === 'boolean') {
      properties[key] = { type: 'boolean' };
    } else if (typeName === 'ZodArray' || typeName === 'array') {
      properties[key] = { type: 'array' };
    } else if (typeName === 'ZodObject' || typeName === 'object') {
      properties[key] = zodToJsonSchema(val);
    } else {
      properties[key] = {};
    }

    if (typeName !== 'ZodOptional' && typeName !== 'optional' && typeName !== 'ZodNullable' && typeName !== 'nullable') {
      required.push(key);
    }
  }

  const schema: Record<string, unknown> = {
    type: 'object',
    properties,
    additionalProperties: def.unknownKeys !== 'passthrough',
  };
  if (required.length > 0) {
    schema.required = required;
  }

  return schema;
}

// Fluent factory helper
export const s = {
  string: (opts?: { minLength?: number; maxLength?: number; pattern?: RegExp }) => new StringValidator(opts),
  number: (opts?: { min?: number; max?: number; integer?: boolean }) => new NumberValidator(opts),
  boolean: () => new BooleanValidator(),
  enum: <T extends string>(values: readonly T[]) => new EnumValidator(values),
  optional: <T>(inner: TypedValidator<T>) => new OptionalValidator(inner),
  array: <T>(item: TypedValidator<T>) => new ArrayValidator(item),
  object: <Shape extends PropertyShape>(props: Shape, opts?: { strict?: boolean }) =>
    new ObjectValidator(props, opts),
};
