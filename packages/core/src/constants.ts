/**
 * Tina4 Constants — HTTP status codes and content types.
 *
 * Standard constants for use in route handlers across all Tina4 frameworks.
 *
 *   import { HTTP_OK, HTTP_CREATED, APPLICATION_JSON } from "@tina4/core";
 *
 *   get("/api/users", async (request, response) => {
 *       return response(users, HTTP_OK);
 *   });
 */

// ── HTTP Status Codes ──

export const HTTP_OK = 200;
export const HTTP_CREATED = 201;
export const HTTP_ACCEPTED = 202;
export const HTTP_NO_CONTENT = 204;

export const HTTP_MOVED = 301;
export const HTTP_REDIRECT = 302;
export const HTTP_NOT_MODIFIED = 304;

export const HTTP_BAD_REQUEST = 400;
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_NOT_FOUND = 404;
export const HTTP_METHOD_NOT_ALLOWED = 405;
export const HTTP_CONFLICT = 409;
export const HTTP_GONE = 410;
export const HTTP_UNPROCESSABLE = 422;
export const HTTP_TOO_MANY = 429;

export const HTTP_SERVER_ERROR = 500;
export const HTTP_BAD_GATEWAY = 502;
export const HTTP_UNAVAILABLE = 503;

// ── Content Types ──

export const APPLICATION_JSON = "application/json";
export const APPLICATION_XML = "application/xml";
export const APPLICATION_FORM = "application/x-www-form-urlencoded";
export const APPLICATION_OCTET = "application/octet-stream";

export const TEXT_HTML = "text/html; charset=utf-8";
export const TEXT_PLAIN = "text/plain; charset=utf-8";
export const TEXT_CSV = "text/csv";
export const TEXT_XML = "text/xml";
