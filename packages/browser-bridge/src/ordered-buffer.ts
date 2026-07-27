export class OrderedBuffer<T> {
  #active = false;
  #values: T[] = [];
  readonly #limit: number;

  constructor(limit = 1_000) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('ordered buffer limit must be a positive integer');
    }
    this.#limit = limit;
  }

  push(value: T, deliver: (value: T) => void): void {
    if (this.#active) {
      deliver(value);
      return;
    }
    if (this.#values.length >= this.#limit) {
      throw new Error('ordered buffer limit exceeded before activation');
    }
    this.#values.push(value);
  }

  activate(deliver: (value: T) => void): void {
    if (this.#active) return;
    this.#active = true;
    const values = this.#values;
    this.#values = [];
    for (const value of values) deliver(value);
  }

  clear(): void {
    this.#values = [];
  }

  get size(): number {
    return this.#values.length;
  }

  get active(): boolean {
    return this.#active;
  }
}
