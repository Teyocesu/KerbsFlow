import { randomUUID } from "node:crypto";
import { IdPrefix } from "./contracts.js";

export interface Clock {
  now(): string;
}

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

export class FixedClock implements Clock {
  private current: string;

  constructor(initial: string) {
    this.current = initial;
  }

  now(): string {
    return this.current;
  }

  set(value: string): void {
    this.current = value;
  }
}

export interface IdSource {
  next(prefix: IdPrefix): string;
}

export class RandomIdSource implements IdSource {
  next(prefix: IdPrefix): string {
    return `${prefix}_${randomUUID().replaceAll("-", "")}`;
  }
}

export class SequenceIdSource implements IdSource {
  private readonly counters = new Map<string, number>();

  constructor(private readonly suffixPrefix = "test") {}

  next(prefix: IdPrefix): string {
    const next = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, next);
    return `${prefix}_${this.suffixPrefix}${next}`;
  }
}
