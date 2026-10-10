// Errors that map to HTTP responses. Messages are safe to show to the client.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const unauthorized = () => new HttpError(401, "unauthorized", "Please choose a demo user first.");
export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found.`);
export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
export const tooManyRequests = () => new HttpError(429, "rate_limited", "Too many messages. Please wait a moment.");
