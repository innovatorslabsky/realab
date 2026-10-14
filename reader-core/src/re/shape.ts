/**
 * Structural inference for JSON: what keys exist, what types they hold, which are optional.
 * It records *shape only*. A string value is reduced to a coarse format label (uuid, iso-datetime,
 * url, …) at the moment it is seen and the value itself is never stored — with one explicit,
 * opt-in exception (`collectEnums`) for short, low-cardinality vocabulary words.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const URL_LIKE = /^https?:\/\//i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEX = /^[0-9a-f]{16,}$/i;
const INT_STRING = /^-?\d+$/;
const ENUM_WORD = /^[a-z][a-z0-9_-]{0,23}$/i;

/** Keys whose values are user content, never vocabulary — enums are never collected for them. */
const CONTENT_KEYS = /title|text|content|html|note|name|author|summary|desc|url|link|email|query|search|body|comment|quote|excerpt|label|tag/i;

export type StringFormat = 'uuid' | 'iso-datetime' | 'date' | 'url' | 'email' | 'hex' | 'int-string' | 'empty' | 'text' | 'string';

export function stringFormat(s: string): StringFormat {
  if (s === '') return 'empty';
  if (UUID.test(s)) return 'uuid';
  if (ISO_DT.test(s)) return 'iso-datetime';
  if (ISO_DATE.test(s)) return 'date';
  if (URL_LIKE.test(s)) return 'url';
  if (EMAIL.test(s)) return 'email';
  if (HEX.test(s)) return 'hex';
  if (INT_STRING.test(s)) return 'int-string';
  return s.length > 200 ? 'text' : 'string';
}

const MAX_KEYS = 300;
const MAX_ITEMS = 50;
const MAX_DEPTH = 8;

export interface ShapeOptions {
  collectEnums: boolean;
}

export class Shape {
  samples = 0;
  objects = 0;
  private types = new Map<string, number>();
  private props = new Map<string, Shape>();
  private items: Shape | undefined;
  private words = new Map<string, number>();
  private stringCount = 0;

  private readonly opts: ShapeOptions;

  constructor(opts: ShapeOptions = { collectEnums: false }) {
    this.opts = opts;
  }

  add(value: unknown, depth = 0): void {
    this.samples++;
    const bump = (t: string): void => {
      this.types.set(t, (this.types.get(t) ?? 0) + 1);
    };
    if (value === null) return bump('null');
    switch (typeof value) {
      case 'boolean':
        return bump('boolean');
      case 'number':
        return bump(Number.isInteger(value) ? 'integer' : 'number');
      case 'string': {
        bump(`string:${stringFormat(value)}`);
        this.stringCount++;
        if (this.opts.collectEnums && ENUM_WORD.test(value)) this.words.set(value, (this.words.get(value) ?? 0) + 1);
        return;
      }
      case 'object':
        break;
      default:
        return bump(typeof value);
    }
    if (depth >= MAX_DEPTH) return bump('deep');
    if (Array.isArray(value)) {
      bump('array');
      this.items ??= new Shape(this.opts);
      for (const v of value.slice(0, MAX_ITEMS)) this.items.add(v, depth + 1);
      return;
    }
    bump('object');
    this.objects++;
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (++n > MAX_KEYS) break;
      let child = this.props.get(k);
      if (!child) this.props.set(k, (child = new Shape(this.opts)));
      child.add(v, depth + 1);
    }
  }

  /** Compact TypeScript-ish rendering, e.g. `{ id: string(uuid); tags?: string[] }`. */
  render(key = '', depth = 0): string {
    if (depth > MAX_DEPTH) return '…';
    const parts: string[] = [];
    const strings = [...this.types].filter(([t]) => t.startsWith('string:'));
    if (strings.length) {
      const formats = strings.map(([t]) => t.slice(7));
      const label = formats.length === 1 && formats[0] === 'string' ? 'string' : `string(${formats.join('|')})`;
      parts.push(label + this.enumSuffix(key, strings.length === 1 && formats[0] === 'string'));
    }
    for (const [t] of this.types) {
      if (t.startsWith('string:')) continue;
      if (t === 'object') parts.push(this.renderObject(depth));
      else if (t === 'array') parts.push(`${wrap(this.items ? this.items.render(key, depth + 1) : 'unknown')}[]`);
      else parts.push(t);
    }
    return parts.join(' | ') || 'unknown';
  }

  private renderObject(depth: number): string {
    if (!this.props.size) return '{}';
    const fields = [...this.props].map(([k, child]) => {
      const optional = child.samples < this.objects ? '?' : '';
      return `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${optional}: ${child.render(k, depth + 1)}`;
    });
    return `{ ${fields.join('; ')} }`;
  }

  /** Vocabulary words, only when opted in, only for non-content keys, and only if clearly an enum. */
  private enumSuffix(key: string, plainString: boolean): string {
    if (!this.opts.collectEnums || !plainString || CONTENT_KEYS.test(key)) return '';
    if (this.stringCount < 3 || this.words.size === 0 || this.words.size > 8) return '';
    const counted = [...this.words.values()].reduce((a, b) => a + b, 0);
    if (counted !== this.stringCount) return ''; // some values were not vocabulary-shaped
    return ` enum(${[...this.words.keys()].sort().map((w) => JSON.stringify(w)).join('|')})`;
  }
}

function wrap(s: string): string {
  return s.includes(' | ') ? `(${s})` : s;
}
