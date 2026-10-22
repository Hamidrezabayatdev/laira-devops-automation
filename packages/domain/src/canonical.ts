import crypto from 'node:crypto';
import type { ActionPlan } from './plan.js';
import { ActionPlanSchema, ActionPlanInputSchema } from './plan.js';

export class CanonicalizationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CanonicalizationError';
  }
}

/**
 * Recursively asserts that a value is completely descriptor-safe:
 * - Pure JSON types only (finite number, string, boolean, null, plain object, array).
 * - Zero accessors (getters/setters) anywhere, with 0 getter invocations.
 * - Zero non-enumerable properties anywhere.
 * - Zero symbol properties anywhere.
 * - Zero undefined properties anywhere (strictly rejected).
 * - Zero sparse arrays.
 * - Zero array custom properties.
 * - Rejects '__proto__' property to prevent prototype poisoning or collisions.
 *
 * Uses static error messages with no user property names.
 */
export function assertDescriptorSafe(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null) {
    return;
  }

  const type = typeof value;

  if (type === 'undefined') {
    throw new CanonicalizationError('Cannot serialize undefined');
  }

  if (type === 'function') {
    throw new CanonicalizationError('Cannot serialize functions');
  }

  if (type === 'symbol') {
    throw new CanonicalizationError('Cannot serialize symbols');
  }

  if (type === 'bigint') {
    throw new CanonicalizationError('Cannot serialize BigInt');
  }

  if (type === 'number') {
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      throw new CanonicalizationError('Cannot serialize non-finite numbers');
    }
    return;
  }

  if (type === 'boolean' || type === 'string') {
    return;
  }

  if (type === 'object') {
    if (seen.has(value as object)) {
      throw new CanonicalizationError('Circular reference detected');
    }
    seen.add(value as object);

    try {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new CanonicalizationError('Symbol properties are not permitted');
      }

      if (Array.isArray(value)) {
        const propNames = Object.getOwnPropertyNames(value);
        const length = value.length;

        for (const prop of propNames) {
          if (prop === 'length') continue;
          const indexNum = Number(prop);
          if (!Number.isInteger(indexNum) || indexNum < 0 || indexNum >= length || String(indexNum) !== prop) {
            throw new CanonicalizationError('Array custom properties are not permitted');
          }
        }

        for (let i = 0; i < length; i++) {
          const indexKey = String(i);
          const desc = Object.getOwnPropertyDescriptor(value, indexKey);

          if (!desc) {
            throw new CanonicalizationError('Sparse arrays are not permitted');
          }

          if (!desc.enumerable) {
            throw new CanonicalizationError('Non-enumerable array elements are not permitted');
          }

          if (desc.get || desc.set) {
            throw new CanonicalizationError('Property accessors are not permitted');
          }

          if (desc.value === undefined) {
            throw new CanonicalizationError('Undefined array elements are not permitted');
          }

          assertDescriptorSafe(desc.value, seen);
        }

        return;
      }

      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalizationError('Non-plain objects are not permitted');
      }

      const propNames = Object.getOwnPropertyNames(value);

      for (const key of propNames) {
        if (key === '__proto__') {
          throw new CanonicalizationError('Prohibited object property: __proto__');
        }

        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (!desc) continue;

        if (!desc.enumerable) {
          throw new CanonicalizationError('Non-enumerable properties are not permitted');
        }

        if (desc.get || desc.set) {
          throw new CanonicalizationError('Property accessors are not permitted');
        }

        if (desc.value === undefined) {
          throw new CanonicalizationError('Undefined properties are not permitted');
        }

        assertDescriptorSafe(desc.value, seen);
      }

      return;
    } finally {
      seen.delete(value as object);
    }
  }

  throw new CanonicalizationError('Unsupported value type');
}

/**
 * Deterministically serializes a value to strict canonical JSON.
 *
 * Rules:
 * - Pure plain JSON values only (string, finite number, boolean, null, plain object, array).
 * - Preserves -0 as JSON '0' (standard standard to avoid hash divergence with 0).
 * - Strictly rejects undefined anywhere: at root, in arrays, and in object properties.
 * - Strictly rejects sparse arrays (e.g. [1, , 3]).
 * - Strictly rejects array custom string/symbol properties (e.g. arr.custom = 1).
 * - Strictly rejects array accessors/getters without executing them (getter count 0).
 * - Strictly rejects non-plain objects: Date, Map, Set, RegExp, Error, TypedArray, and custom classes.
 * - Strictly rejects objects with symbol keys (Object.getOwnPropertySymbols).
 * - Strictly rejects object non-enumerable properties.
 * - Strictly rejects property accessors (getters/setters) to prevent arbitrary code execution or mutable state during hashing.
 * - Recursively sorts all object keys in lexicographical Unicode order.
 * - Preserves array order.
 * - Detects and rejects circular references.
 */
export function canonicalJsonStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) {
    return 'null';
  }

  const type = typeof value;

  if (type === 'undefined') {
    throw new CanonicalizationError('Cannot canonically serialize undefined');
  }

  if (type === 'function') {
    throw new CanonicalizationError('Cannot canonically serialize functions');
  }

  if (type === 'symbol') {
    throw new CanonicalizationError('Cannot canonically serialize symbols');
  }

  if (type === 'bigint') {
    throw new CanonicalizationError('Cannot canonically serialize BigInt');
  }

  if (type === 'number') {
    if (Number.isNaN(value)) {
      throw new CanonicalizationError('Cannot canonically serialize NaN');
    }
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError('Cannot canonically serialize non-finite numbers');
    }
    // Documented: preserve -0 as standard JSON '0' to avoid hash collisions or divergence with 0
    if (Object.is(value, -0)) {
      return '0';
    }
    return JSON.stringify(value);
  }

  if (type === 'boolean' || type === 'string') {
    return JSON.stringify(value);
  }

  if (type === 'object') {
    if (seen.has(value as object)) {
      throw new CanonicalizationError('Circular reference detected during canonical serialization');
    }
    seen.add(value as object);

    try {
      if (Array.isArray(value)) {
        if (Object.getOwnPropertySymbols(value).length > 0) {
          throw new CanonicalizationError('Symbol properties are not permitted');
        }

        const propNames = Object.getOwnPropertyNames(value);
        const length = value.length;

        for (const prop of propNames) {
          if (prop === 'length') continue;
          const indexNum = Number(prop);
          if (!Number.isInteger(indexNum) || indexNum < 0 || indexNum >= length || String(indexNum) !== prop) {
            throw new CanonicalizationError('Array custom properties are not permitted');
          }
        }

        const elements: string[] = [];

        for (let i = 0; i < length; i++) {
          const indexKey = String(i);
          const desc = Object.getOwnPropertyDescriptor(value, indexKey);

          if (!desc) {
            throw new CanonicalizationError('Sparse arrays are not permitted');
          }

          if (!desc.enumerable) {
            throw new CanonicalizationError('Non-enumerable array elements are not permitted');
          }

          if (desc.get || desc.set) {
            throw new CanonicalizationError('Property accessors are not permitted');
          }

          const elem = desc.value;
          if (elem === undefined) {
            throw new CanonicalizationError('Undefined array elements are not permitted');
          }

          elements.push(canonicalJsonStringify(elem, seen));
        }

        return `[${elements.join(',')}]`;
      }

      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalizationError('Non-plain objects are not permitted');
      }

      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new CanonicalizationError('Symbol properties are not permitted');
      }

      const propNames = Object.getOwnPropertyNames(value);

      for (const key of propNames) {
        if (key === '__proto__') {
          throw new CanonicalizationError('Prohibited object property: __proto__');
        }

        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (!desc) continue;

        if (!desc.enumerable) {
          throw new CanonicalizationError('Non-enumerable properties are not permitted');
        }

        if (desc.get || desc.set) {
          throw new CanonicalizationError('Property accessors are not permitted');
        }

        if (desc.value === undefined) {
          throw new CanonicalizationError('Undefined properties are not permitted');
        }
      }

      const keys = [...propNames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      const entries: string[] = [];
      for (const key of keys) {
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (!desc) continue;
        entries.push(`${JSON.stringify(key)}:${canonicalJsonStringify(desc.value, seen)}`);
      }

      return `{${entries.join(',')}}`;
    } finally {
      seen.delete(value as object);
    }
  }

  throw new CanonicalizationError('Unsupported value type');
}

/**
 * Computes a deterministic SHA-256 hash of an ActionPlan or plan-like structure.
 *
 * Strict Design:
 * - STRICT hash of the supplied JSON representation excluding canonicalHash ONLY.
 * - NEVER schema-normalizes or drops undefined within hash computation.
 * - Validates descriptors on entire root structure before any reads or copy.
 * - Rejects root accessors/getters with 0 getter invocations.
 * - Rejects non-enumerable extras and symbol properties.
 * - Strips `canonicalHash` property descriptor-safely using null-prototype data descriptors.
 */
export function computeActionPlanHash(
  plan: Omit<ActionPlan, 'canonicalHash'> | ActionPlan
): string {
  if (typeof plan !== 'object' || plan === null) {
    throw new CanonicalizationError('ActionPlan must be a non-null object');
  }

  const proto = Object.getPrototypeOf(plan);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalizationError('Non-plain objects are not permitted');
  }

  if (Object.getOwnPropertySymbols(plan).length > 0) {
    throw new CanonicalizationError('Symbol properties are not permitted');
  }

  const propNames = Object.getOwnPropertyNames(plan);

  for (const key of propNames) {
    if (key === '__proto__') {
      throw new CanonicalizationError('Prohibited object property: __proto__');
    }

    const desc = Object.getOwnPropertyDescriptor(plan, key);
    if (!desc) continue;

    if (desc.get || desc.set) {
      throw new CanonicalizationError('Property accessors are not permitted');
    }

    if (!desc.enumerable) {
      throw new CanonicalizationError('Non-enumerable properties are not permitted');
    }
  }

  // Build clean plan object without canonicalHash using null-prototype data descriptors
  const planWithoutHash = Object.create(null);
  for (const key of propNames) {
    if (key === 'canonicalHash') continue;
    const desc = Object.getOwnPropertyDescriptor(plan, key)!;
    // Strict: never schema-normalize or drop undefined within hash!
    Object.defineProperty(planWithoutHash, key, {
      value: desc.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const canonicalString = canonicalJsonStringify(planWithoutHash);
  return crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}

/**
 * Normalizes an ActionPlan input before hashing, display, and approval:
 * 1. Pre-validates descriptor safety on raw input BEFORE Zod (0 getters executed, rejects raw undefined).
 * 2. Applies ActionPlanSchema to validate types and apply schema defaults ONCE.
 * 3. Strips optional properties where value is undefined (only those from schema optional outputs).
 * 4. Computes deterministic canonicalHash on the normalized representation.
 * 5. Returns approval-ready normalized ActionPlan.
 *
 * Lifecycle: normalizeActionPlan(input) -> compute hash -> persist/display -> approve.
 */
export function normalizeActionPlan(rawPlan: unknown): ActionPlan {
  // 1. Descriptor-validate input BEFORE Zod (rejects getters with calls: 0, rejects raw undefined)
  assertDescriptorSafe(rawPlan);

  // 2. Schema apply defaults ONCE
  const parsed = ActionPlanInputSchema.parse(rawPlan);

  // 3. Remove undefined ONLY generated by schema optional outputs using null-proto/data descriptors
  const cleanPlan = stripSchemaUndefined(parsed);

  // 4. Compute strict hash on normalized representation
  const hash = computeActionPlanHash(cleanPlan as unknown as Omit<ActionPlan, 'canonicalHash'>);
  cleanPlan.canonicalHash = hash;

  return ActionPlanSchema.parse(cleanPlan);
}

function stripSchemaUndefined<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value as object)) {
    throw new CanonicalizationError('Circular reference detected');
  }
  seen.add(value as object);

  try {
    if (Array.isArray(value)) {
      const arrResult: unknown[] = [];
      const len = value.length;
      for (let i = 0; i < len; i++) {
        const desc = Object.getOwnPropertyDescriptor(value, String(i));
        if (!desc || desc.value === undefined) continue;
        arrResult.push(stripSchemaUndefined(desc.value, seen));
      }
      return arrResult as unknown as T;
    }

    const objResult = Object.create(null);
    const keys = Object.getOwnPropertyNames(value);
    for (const key of keys) {
      if (key === '__proto__') continue;
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || desc.value === undefined) continue;

      Object.defineProperty(objResult, key, {
        value: stripSchemaUndefined(desc.value, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }

    return Object.assign({}, objResult) as T;
  } finally {
    seen.delete(value as object);
  }
}

/**
 * Verifies that the canonicalHash embedded in an ActionPlan matches its current computed hash.
 * Inspects descriptor safely before accessing any properties; 0 getters executed.
 */
export function verifyActionPlanHash(plan: ActionPlan): boolean {
  if (typeof plan !== 'object' || plan === null) return false;
  try {
    assertDescriptorSafe(plan);
    const desc = Object.getOwnPropertyDescriptor(plan, 'canonicalHash');
    if (!desc || desc.get || desc.set || typeof desc.value !== 'string') {
      return false;
    }
    const computed = computeActionPlanHash(plan);
    return computed === desc.value;
  } catch {
    return false;
  }
}
