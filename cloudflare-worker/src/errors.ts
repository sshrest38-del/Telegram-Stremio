/**
 * Error classes for standard HTTP status code mapping.
 */

export class HttpError extends Error {
  public readonly status: number;
  public readonly headers: Record<string, string>;

  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.headers = headers;
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string = "Bad Request") {
    super(400, message);
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message: string = "Unauthorized") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends HttpError {
  constructor(message: string = "Forbidden") {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string = "Not Found") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

export class RangeNotSatisfiableError extends HttpError {
  constructor(totalSize?: number) {
    const headers: Record<string, string> = {};
    if (typeof totalSize === "number" && totalSize >= 0) {
      headers["Content-Range"] = `bytes */${totalSize}`;
    }
    super(416, "Range Not Satisfiable", headers);
    this.name = "RangeNotSatisfiableError";
  }
}

export class BadGatewayError extends HttpError {
  constructor(message: string = "Bad Gateway") {
    super(502, message);
    this.name = "BadGatewayError";
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(message: string = "Service Unavailable") {
    super(503, message);
    this.name = "ServiceUnavailableError";
  }
}

export class GatewayTimeoutError extends HttpError {
  constructor(message: string = "Gateway Timeout") {
    super(504, message);
    this.name = "GatewayTimeoutError";
  }
}
