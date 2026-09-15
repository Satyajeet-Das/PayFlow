// src/common/exceptions/payflow.exception.ts
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * PayFlowException
 *
 * Base exception class for all domain and operational errors in PayFlow.
 * Enforces structured machine-readable error codes (e.g. 'INVALID_STATE_TRANSITION',
 * 'IDEMPOTENCY_CONFLICT', 'PAYMENT_NOT_FOUND') alongside human-readable messages,
 * HTTP status codes, and optional context details.
 */
export class PayFlowException extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details?: Record<string, any>,
  ) {
    super(
      {
        code,
        message,
        ...(details ? { details } : {}),
      },
      status,
    );
  }
}
