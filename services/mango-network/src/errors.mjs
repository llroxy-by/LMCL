export class ServiceError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new ServiceError(code, message, details);
}
