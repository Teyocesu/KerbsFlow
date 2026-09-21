export class KerbsFlowError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "KerbsFlowError";
  }
}

export class NotFoundError extends KerbsFlowError {
  constructor(resource: string, id: string) {
    super("NOT_FOUND", `${resource} ${id} was not found`, { resource, id });
  }
}

export class StateVersionConflictError extends KerbsFlowError {
  constructor(runId: string, expected: number, actual: number) {
    super("STATE_VERSION_CONFLICT", `run ${runId} expected state version ${expected}, found ${actual}`, { runId, expected, actual });
  }
}

export class IdempotencyConflictError extends KerbsFlowError {
  constructor(idempotencyKey: string) {
    super("IDEMPOTENCY_CONFLICT", `idempotency key ${idempotencyKey} was already used for a different semantic request`, { idempotencyKey });
  }
}

export class DatabaseIntegrityError extends KerbsFlowError {
  constructor(message: string) {
    super("DATABASE_INTEGRITY", message);
  }
}
