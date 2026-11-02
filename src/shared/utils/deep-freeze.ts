/**
 * Freezes an object and everything inside it, so a constant shared by the whole process cannot be changed by accident.
 * Assigning to a frozen object throws in strict mode (every module here is one) instead of silently changing shared state.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}
