export class PendingPortMessages {
  #messages = new Map<string, unknown[]>();
  #messageCount = 0;
  readonly #maxPorts: number;
  readonly #maxMessages: number;

  constructor(maxPorts = 64, maxMessages = 10_000) {
    if (!Number.isSafeInteger(maxPorts) || maxPorts < 1) {
      throw new Error('pending port limit must be a positive integer');
    }
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) {
      throw new Error('pending message limit must be a positive integer');
    }
    this.#maxPorts = maxPorts;
    this.#maxMessages = maxMessages;
  }

  queue(portId: string, message: unknown): void {
    let messages = this.#messages.get(portId);
    if (messages === undefined) {
      if (this.#messages.size >= this.#maxPorts) {
        throw new Error('pending AppHost port limit exceeded');
      }
      messages = [];
      this.#messages.set(portId, messages);
    }
    if (this.#messageCount >= this.#maxMessages) {
      throw new Error('pending AppHost message limit exceeded');
    }
    messages.push(message);
    this.#messageCount += 1;
  }

  drain(portId: string, deliver: (message: unknown) => void): void {
    const messages = this.#messages.get(portId);
    if (messages === undefined) return;
    this.#messages.delete(portId);
    this.#messageCount -= messages.length;
    for (const message of messages) deliver(message);
  }

  clear(): void {
    this.#messages.clear();
    this.#messageCount = 0;
  }

  get messageCount(): number {
    return this.#messageCount;
  }
}
