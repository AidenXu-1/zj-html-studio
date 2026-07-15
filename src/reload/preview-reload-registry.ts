import { normalizeScopePath } from "../settings";

interface ReloadRegistration {
  callback: () => void | Promise<void>;
  dependencies: Set<string>;
  pending: boolean;
  running: boolean;
}

export type ReloadErrorHandler = (id: string, error: unknown) => void;

export interface TimerScheduler {
  clearTimeout(handle: number): void;
  setTimeout(callback: () => void, delayMs: number): number;
}

export class BoundedPathChangeLog {
  private droppedThrough = 0;
  private readonly entries: Array<{ path: string; sequence: number }> = [];
  private sequence = 0;

  constructor(private readonly maxEntries = 4_096) {}

  checkpoint(): number {
    return this.sequence;
  }

  record(changedPath: string): void {
    const normalized = normalizeScopePath(changedPath);
    if (!normalized) return;
    this.sequence += 1;
    this.entries.push({ path: normalized, sequence: this.sequence });
    while (this.entries.length > Math.max(1, this.maxEntries)) {
      const dropped = this.entries.shift();
      if (dropped) this.droppedThrough = dropped.sequence;
    }
  }

  hasAnySince(checkpoint: number, paths: Iterable<string>): boolean {
    const relevantPaths = new Set([...paths].map(normalizeScopePath).filter(Boolean));
    if (relevantPaths.size === 0) return false;
    if (checkpoint < this.droppedThrough) return true;
    return this.entries.some(entry => entry.sequence > checkpoint && relevantPaths.has(entry.path));
  }
}

export class PreviewReloadRegistry {
  private readonly registrations = new Map<string, ReloadRegistration>();
  private readonly timers = new Map<string, number>();

  constructor(
    private readonly debounceMs = 160,
    private readonly maxDependencies = 2_000,
    private readonly onError: ReloadErrorHandler = () => undefined,
    private readonly timerScheduler: TimerScheduler = window
  ) {}

  register(
    id: string,
    dependencies: Iterable<string>,
    callback: () => void | Promise<void>
  ): () => void {
    this.unregister(id);
    this.registrations.set(id, {
      callback,
      dependencies: new Set([...dependencies].map(normalizeScopePath).filter(Boolean).slice(0, this.maxDependencies)),
      pending: false,
      running: false
    });
    return () => this.unregister(id);
  }

  addDependency(id: string, dependencyPath: string): boolean {
    const normalized = normalizeScopePath(dependencyPath);
    if (!normalized) return false;
    const registration = this.registrations.get(id);
    if (!registration) return false;
    if (registration.dependencies.has(normalized)) return true;
    if (registration.dependencies.size >= this.maxDependencies) return false;
    registration.dependencies.add(normalized);
    return true;
  }

  replaceDependencies(id: string, dependencies: Iterable<string>): boolean {
    const registration = this.registrations.get(id);
    if (!registration) return false;
    registration.dependencies = new Set(
      [...dependencies].map(normalizeScopePath).filter(Boolean).slice(0, this.maxDependencies)
    );
    return true;
  }

  getDependencies(id: string): string[] {
    return [...(this.registrations.get(id)?.dependencies ?? [])];
  }

  notifyPathChanged(changedPath: string): void {
    const normalized = normalizeScopePath(changedPath);
    if (!normalized) return;

    this.registrations.forEach((registration, id) => {
      if (!registration.dependencies.has(normalized)) return;
      this.scheduleRegistration(id, registration);
    });
  }

  requestReload(id: string): boolean {
    const registration = this.registrations.get(id);
    if (!registration) return false;
    this.scheduleRegistration(id, registration);
    return true;
  }

  unregister(id: string): void {
    this.registrations.delete(id);
    const timer = this.timers.get(id);
    if (timer) this.timerScheduler.clearTimeout(timer);
    this.timers.delete(id);
  }

  clear(): void {
    [...this.registrations.keys()].forEach(id => this.unregister(id));
  }

  private async runRegistration(id: string, registration: ReloadRegistration): Promise<void> {
    if (registration.running) {
      registration.pending = true;
      return;
    }

    registration.running = true;
    try {
      do {
        registration.pending = false;
        try {
          await registration.callback();
        } catch (error) {
          this.onError(id, error);
        }
      } while (registration.pending && this.registrations.get(id) === registration);
    } finally {
      registration.running = false;
    }
  }

  private scheduleRegistration(id: string, registration: ReloadRegistration): void {
    const existingTimer = this.timers.get(id);
    if (existingTimer) this.timerScheduler.clearTimeout(existingTimer);

    const timer = this.timerScheduler.setTimeout(() => {
      this.timers.delete(id);
      if (this.registrations.get(id) !== registration) return;
      void this.runRegistration(id, registration);
    }, this.debounceMs);
    this.timers.set(id, timer);
  }
}
