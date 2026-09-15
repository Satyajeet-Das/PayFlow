// src/common/filters/http-exception.filter.ts
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { PayFlowException } from '../exceptions/payflow.exception';

export interface ErrorResponse {
  statusCode: number;
  error: string;
  code: string;
  message: string | string[];
  details?: Record<string, any>;
  timestamp: string;
  path: string;
  requestId: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId = (request.headers['x-request-id'] as string) ?? randomUUID();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'Internal Server Error';
    let code = 'INTERNAL_SERVER_ERROR';
    let details: Record<string, any> | undefined;

    if (exception instanceof PayFlowException) {
      statusCode = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
      error = this.formatErrorName(statusCode);
    } else if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
        error = this.formatErrorName(statusCode);
        code = this.formatCodeFromStatus(statusCode);
      } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const resp = exceptionResponse as Record<string, unknown>;
        message = (resp['message'] as string | string[]) ?? exception.message;
        error = (resp['error'] as string) ?? this.formatErrorName(statusCode);
        code = (resp['code'] as string) ?? this.formatCodeFromStatus(statusCode);
        details = resp['details'] as Record<string, any> | undefined;
      } else {
        error = this.formatErrorName(statusCode);
        code = this.formatCodeFromStatus(statusCode);
      }
    } else if (exception instanceof Error) {
      // Do NOT leak internal errors or stack traces to client
      this.logger.error({
        message: exception.message,
        stack: exception.stack,
        requestId,
        path: request.url,
      });
    } else {
      this.logger.error({
        message: 'Unknown non-error exception thrown',
        exception,
        requestId,
        path: request.url,
      });
    }

    const body: ErrorResponse = {
      statusCode,
      error,
      code,
      message,
      ...(details ? { details } : {}),
      timestamp: new Date().toISOString(),
      path: request.url,
      requestId,
    };

    this.logger.warn({
      ...body,
      method: request.method,
    });

    response.status(statusCode).json(body);
  }

  private formatCodeFromStatus(statusCode: number): string {
    const statusName = HttpStatus[statusCode];
    if (statusName && typeof statusName === 'string') {
      return statusName;
    }
    return 'UNKNOWN_ERROR';
  }

  private formatErrorName(statusCode: number): string {
    const statusName = HttpStatus[statusCode];
    if (!statusName || typeof statusName !== 'string') {
      return 'Error';
    }
    return statusName
      .toLowerCase()
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
