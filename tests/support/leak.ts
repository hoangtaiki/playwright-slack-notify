/**
 * Deep-walks `value` looking for any of `secrets` as a substring, reaching
 * places `JSON.stringify` cannot: non-enumerable properties (Error.message,
 * Error.stack), the full `cause` chain, and cyclic structures. Throws with a
 * message naming `where` if found.
 *
 * This is the thing that proves the OTHER leak tests are not vacuously
 * green - see tests/send.spec.ts's dedicated test of this function itself.
 */
export function assertNoSecret(
  value: unknown,
  secrets: readonly string[],
  where: string
): void {
  const seen = new WeakSet<object>();
  const hit = walk(value, secrets, seen);
  if (hit) {
    throw new Error(
      `secret leak detected in ${where}: found "${hit.secret}" at ${hit.path || '(root)'}`
    );
  }
}

interface Hit {
  readonly secret: string;
  readonly path: string;
}

function containsAny(
  text: string,
  secrets: readonly string[]
): string | undefined {
  return secrets.find(s => s.length >= 4 && text.includes(s));
}

function walk(
  value: unknown,
  secrets: readonly string[],
  seen: WeakSet<object>,
  path = ''
): Hit | undefined {
  if (value == null) return undefined;

  if (typeof value === 'string') {
    const secret = containsAny(value, secrets);
    return secret ? { secret, path } : undefined;
  }

  if (typeof value !== 'object' && typeof value !== 'function')
    return undefined;

  const obj = value as object;
  if (seen.has(obj)) return undefined;
  seen.add(obj);

  if (value instanceof Error) {
    const messageHit = containsAny(value.message ?? '', secrets);
    if (messageHit) return { secret: messageHit, path: `${path}.message` };
    const stackHit = containsAny(value.stack ?? '', secrets);
    if (stackHit) return { secret: stackHit, path: `${path}.stack` };
    const cause = (value as { cause?: unknown }).cause;
    if (cause !== undefined) {
      const causeHit = walk(cause, secrets, seen, `${path}.cause`);
      if (causeHit) return causeHit;
    }
    // Fall through to the generic own-properties walk below, to also catch
    // any custom property a caller attached to the Error.
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = walk(value[i], secrets, seen, `${path}[${i}]`);
      if (hit) return hit;
    }
    return undefined;
  }

  if (value instanceof Map) {
    for (const [k, v] of value) {
      const hit = walk(v, secrets, seen, `${path}.get(${String(k)})`);
      if (hit) return hit;
    }
    return undefined;
  }

  if (value instanceof Set) {
    let i = 0;
    for (const v of value) {
      const hit = walk(v, secrets, seen, `${path}[Set:${i++}]`);
      if (hit) return hit;
    }
    return undefined;
  }

  // getOwnPropertyNames, not Object.keys/entries: reaches non-enumerable
  // properties like Error.message and Error.stack on engines where they are
  // defined that way, and any other hidden property a library might attach.
  for (const key of Object.getOwnPropertyNames(obj)) {
    let propValue: unknown;
    try {
      propValue = (obj as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    if (typeof propValue === 'function') continue;
    const hit = walk(propValue, secrets, seen, `${path}.${key}`);
    if (hit) return hit;
  }
  return undefined;
}
