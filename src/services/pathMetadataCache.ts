function normalizePathMetadataKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

export class BoundedPathMetadataCache<Value> {
  private readonly entries = new Map<string, Value>();

  constructor(private readonly maxEntries = 64) {}

  get(path: string): Value | undefined {
    return this.entries.get(normalizePathMetadataKey(path));
  }

  set(path: string, value: Value): void {
    const key = normalizePathMetadataKey(path);
    this.entries.delete(key);
    this.entries.set(key, value);
    this.evictToLimit();
  }

  retain(paths: Iterable<string>): void {
    const retained = new Set(Array.from(paths, normalizePathMetadataKey));
    for (const key of this.entries.keys()) {
      if (!retained.has(key)) this.entries.delete(key);
    }
    this.evictToLimit();
  }

  get size(): number {
    return this.entries.size;
  }

  private evictToLimit(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}
