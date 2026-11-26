export class ContextDeckError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code = 'CONTEXTDECK_ERROR',
    statusCode = 400,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class NotFoundError extends ContextDeckError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'NOT_FOUND', 404, details);
  }
}

export class ConflictError extends ContextDeckError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFLICT', 409, details);
  }
}

export class ValidationError extends ContextDeckError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, details);
  }
}

export class SecurityError extends ContextDeckError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'SECURITY_ERROR', 403, details);
  }
}

export class CorruptDataError extends ContextDeckError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CORRUPT_DATA', 500, details);
  }
}

export class LockCompromisedError extends ContextDeckError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'LOCK_COMPROMISED', 503, details);
  }
}

export class LockTimeoutError extends ContextDeckError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'LOCK_TIMEOUT', 503, details);
  }
}

export class WorkspaceNotFoundError extends ContextDeckError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'WORKSPACE_NOT_FOUND', 404, details);
  }
}

export class PayloadTooLargeError extends ContextDeckError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'PAYLOAD_TOO_LARGE', 413, details);
  }
}
