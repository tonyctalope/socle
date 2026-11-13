// The shapes a server function accepts, as a small subset of JSON Schema. The same
// file runs in two places: inside the sandbox (the `v` builder apps write, and the
// check of every call's input) and on the host (reading what a build declared).
// It must therefore stay free of imports and of anything outside plain ECMAScript.

export type Schema =
  | { type: 'string'; minLength?: number; maxLength?: number; enum?: string[]; format?: 'date'; description?: string }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number; description?: string }
  | { type: 'boolean'; description?: string }
  | { type: 'null'; description?: string }
  | { type: 'array'; items: Schema; minItems?: number; maxItems?: number; description?: string }
  | {
      type: 'object';
      properties: Record<string, Schema>;
      required: string[];
      additionalProperties: false;
      description?: string;
    }
  | { anyOf: Schema[]; description?: string }
  | { description?: string }; // anything

const MAX_DEPTH = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

function isBound(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

/** Null when `value` is a schema of the subset above, else what is wrong with it. */
export function schemaProblem(value: unknown, path = 'schema', depth = 0): string | null {
  if (depth > MAX_DEPTH) return `${path}: nested too deeply`;
  if (!isRecord(value)) return `${path}: expected a schema object`;
  if (value.description !== undefined && typeof value.description !== 'string') {
    return `${path}.description: expected text`;
  }
  if ('anyOf' in value) {
    if (!Array.isArray(value.anyOf) || value.anyOf.length === 0 || value.anyOf.length > 16) {
      return `${path}.anyOf: expected 1 to 16 schemas`;
    }
    for (let index = 0; index < value.anyOf.length; index++) {
      const problem = schemaProblem(value.anyOf[index], `${path}.anyOf[${index}]`, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  switch (value.type) {
    case undefined:
    case 'boolean':
    case 'null':
      return null;
    case 'string':
      if (!isCount(value.minLength) || !isCount(value.maxLength)) return `${path}: invalid length bounds`;
      if (value.format !== undefined && value.format !== 'date') return `${path}.format: only "date" is supported`;
      if (value.enum !== undefined) {
        if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 200) {
          return `${path}.enum: expected 1 to 200 values`;
        }
        if (!value.enum.every((item) => typeof item === 'string')) return `${path}.enum: expected text values`;
      }
      return null;
    case 'number':
    case 'integer':
      return isBound(value.minimum) && isBound(value.maximum) ? null : `${path}: invalid bounds`;
    case 'array':
      if (!isCount(value.minItems) || !isCount(value.maxItems)) return `${path}: invalid length bounds`;
      return schemaProblem(value.items, `${path}.items`, depth + 1);
    case 'object': {
      if (!isRecord(value.properties)) return `${path}.properties: expected an object`;
      const names = Object.keys(value.properties);
      if (names.length > 100) return `${path}: too many properties`;
      if (!Array.isArray(value.required) || !value.required.every((name) => names.includes(name as string))) {
        return `${path}.required: must list properties of the object`;
      }
      if (value.additionalProperties !== false) return `${path}.additionalProperties: must be false`;
      for (const name of names) {
        const problem = schemaProblem(value.properties[name], `${path}.${name}`, depth + 1);
        if (problem) return problem;
      }
      return null;
    }
    default:
      return `${path}.type: unsupported type ${JSON.stringify(value.type)}`;
  }
}

function isRealDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

// What a refused value is told, in the instance's language: a screen may show it as it is.
interface Words {
  shape: string;
  null: string;
  boolean: string;
  text: string;
  oneOf: (values: string) => string;
  empty: string;
  minLength: (n: number) => string;
  maxLength: (n: number) => string;
  date: string;
  number: string;
  integer: string;
  minimum: (n: number) => string;
  maximum: (n: number) => string;
  list: string;
  minItems: (n: number) => string;
  maxItems: (n: number) => string;
  object: string;
  unknown: string;
  required: string;
}

const WORDS: Record<string, Words> = {
  en: {
    shape: 'no accepted shape',
    null: 'expected null',
    boolean: 'expected true or false',
    text: 'expected text',
    oneOf: (values) => `expected one of ${values}`,
    empty: 'must not be empty',
    minLength: (n) => `at least ${n} characters`,
    maxLength: (n) => `at most ${n} characters`,
    date: 'expected a date as YYYY-MM-DD',
    number: 'expected a number',
    integer: 'expected a whole number',
    minimum: (n) => `must be at least ${n}`,
    maximum: (n) => `must be at most ${n}`,
    list: 'expected a list',
    minItems: (n) => `at least ${n} item(s)`,
    maxItems: (n) => `at most ${n} item(s)`,
    object: 'expected an object',
    unknown: 'unknown field',
    required: 'required',
  },
  fr: {
    shape: 'aucune forme acceptée',
    null: 'null attendu',
    boolean: 'vrai ou faux attendu',
    text: 'texte attendu',
    oneOf: (values) => `une de ces valeurs attendue : ${values}`,
    empty: 'ne doit pas être vide',
    minLength: (n) => `au moins ${n} caractères`,
    maxLength: (n) => `au plus ${n} caractères`,
    date: 'date attendue au format AAAA-MM-JJ',
    number: 'nombre attendu',
    integer: 'nombre entier attendu',
    minimum: (n) => `doit valoir au moins ${n}`,
    maximum: (n) => `doit valoir au plus ${n}`,
    list: 'liste attendue',
    minItems: (n) => `au moins ${n} élément(s)`,
    maxItems: (n) => `au plus ${n} élément(s)`,
    object: 'objet attendu',
    unknown: 'champ inconnu',
    required: 'obligatoire',
  },
};

/** Null when `value` fits `schema`, else the first problem, written for whoever sent the value. */
export function validate(schema: Schema, value: unknown, path = 'input', locale = 'en'): string | null {
  const say = WORDS[locale] ?? WORDS.en!;
  if ('anyOf' in schema) {
    const problems = schema.anyOf.map((option) => validate(option, value, path, locale));
    return problems.includes(null) ? null : (problems[0] ?? `${path}: ${say.shape}`);
  }
  if (!('type' in schema)) return null;
  switch (schema.type) {
    case 'null':
      return value === null ? null : `${path}: ${say.null}`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path}: ${say.boolean}`;
    case 'string': {
      if (typeof value !== 'string') return `${path}: ${say.text}`;
      if (schema.enum && !schema.enum.includes(value)) return `${path}: ${say.oneOf(schema.enum.join(', '))}`;
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return schema.minLength === 1 ? `${path}: ${say.empty}` : `${path}: ${say.minLength(schema.minLength)}`;
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `${path}: ${say.maxLength(schema.maxLength)}`;
      }
      if (schema.format === 'date' && !isRealDate(value)) return `${path}: ${say.date}`;
      return null;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${path}: ${say.number}`;
      if (schema.type === 'integer' && !Number.isSafeInteger(value)) return `${path}: ${say.integer}`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${path}: ${say.minimum(schema.minimum)}`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${path}: ${say.maximum(schema.maximum)}`;
      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${path}: ${say.list}`;
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return `${path}: ${say.minItems(schema.minItems)}`;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return `${path}: ${say.maxItems(schema.maxItems)}`;
      }
      for (let index = 0; index < value.length; index++) {
        const problem = validate(schema.items, value[index], `${path}[${index}]`, locale);
        if (problem) return problem;
      }
      return null;
    }
    case 'object': {
      if (!isRecord(value)) return `${path}: ${say.object}`;
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, name)) return `${path}.${name}: ${say.unknown}`;
      }
      for (const name of Object.keys(schema.properties)) {
        if (value[name] === undefined) {
          if (schema.required.includes(name)) return `${path}.${name}: ${say.required}`;
          continue;
        }
        const problem = validate(schema.properties[name]!, value[name], `${path}.${name}`, locale);
        if (problem) return problem;
      }
      return null;
    }
  }
}

/**
 * What apps write: v.object({ label: v.string().min(1).max(80), cents: v.int().min(1) }).
 * Every method returns a new value, so a shared piece can be refined without side effects.
 */
export class SchemaBuilder {
  readonly schema: Schema;
  readonly isOptional: boolean;

  constructor(schema: Schema, isOptional = false) {
    this.schema = schema;
    this.isOptional = isOptional;
  }

  private with(extra: Record<string, unknown>): SchemaBuilder {
    return new SchemaBuilder({ ...this.schema, ...extra } as Schema, this.isOptional);
  }

  private bound(low: boolean, value: number): SchemaBuilder {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('v: min() and max() take a number');
    const type = 'type' in this.schema ? this.schema.type : undefined;
    if (type === 'string') return this.with(low ? { minLength: value } : { maxLength: value });
    if (type === 'array') return this.with(low ? { minItems: value } : { maxItems: value });
    if (type === 'number' || type === 'integer') return this.with(low ? { minimum: value } : { maximum: value });
    throw new TypeError('v: min() and max() apply to text, numbers and lists');
  }

  min(value: number): SchemaBuilder {
    return this.bound(true, value);
  }

  max(value: number): SchemaBuilder {
    return this.bound(false, value);
  }

  /** Text that must be a calendar date written YYYY-MM-DD. */
  date(): SchemaBuilder {
    if (!('type' in this.schema) || this.schema.type !== 'string') throw new TypeError('v: date() applies to text');
    return this.with({ format: 'date' });
  }

  /** Shown to Claude when the function is offered as a tool. */
  describe(description: string): SchemaBuilder {
    return this.with({ description: String(description) });
  }

  /** The field may be left out (only meaningful inside v.object). */
  optional(): SchemaBuilder {
    return new SchemaBuilder(this.schema, true);
  }

  nullable(): SchemaBuilder {
    return new SchemaBuilder({ anyOf: [this.schema, { type: 'null' }] }, this.isOptional);
  }

  toJSON(): Schema {
    return this.schema;
  }
}

function inner(value: unknown, what: string): SchemaBuilder {
  if (!(value instanceof SchemaBuilder)) throw new TypeError(`v: ${what} must be built with v.string(), v.int(), …`);
  return value;
}

export const v = {
  string: () => new SchemaBuilder({ type: 'string' }),
  number: () => new SchemaBuilder({ type: 'number' }),
  int: () => new SchemaBuilder({ type: 'integer' }),
  boolean: () => new SchemaBuilder({ type: 'boolean' }),
  any: () => new SchemaBuilder({}),
  enum: (values: string[]) => {
    if (!Array.isArray(values) || values.length === 0 || !values.every((value) => typeof value === 'string')) {
      throw new TypeError('v.enum takes a non-empty list of texts');
    }
    return new SchemaBuilder({ type: 'string', enum: [...values] });
  },
  array: (items: SchemaBuilder) =>
    new SchemaBuilder({ type: 'array', items: inner(items, 'the items of v.array').schema }),
  object: (shape: Record<string, SchemaBuilder>) => {
    if (!isRecord(shape)) throw new TypeError('v.object takes an object of fields');
    const properties: Record<string, Schema> = {};
    const required: string[] = [];
    for (const name of Object.keys(shape)) {
      const field = inner(shape[name], `the field "${name}"`);
      properties[name] = field.schema;
      if (!field.isOptional) required.push(name);
    }
    return new SchemaBuilder({ type: 'object', properties, required, additionalProperties: false });
  },
  union: (...options: SchemaBuilder[]) =>
    new SchemaBuilder({ anyOf: options.map((option) => inner(option, 'each option of v.union').schema) }),
};
