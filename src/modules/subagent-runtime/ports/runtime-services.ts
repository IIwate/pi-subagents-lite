export interface RuntimeClock {
  now(): number;
}

export interface IdGenerator {
  nextId(): string;
}

export interface ScheduledHandle {
  clear(): void;
}

export interface RuntimeScheduler {
  interval(ms: number, callback: () => void): ScheduledHandle;
  timeout(ms: number, callback: () => void): ScheduledHandle;
}
