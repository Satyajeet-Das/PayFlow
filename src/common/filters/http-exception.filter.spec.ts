// src/common/filters/http-exception.filter.spec.ts
import { ArgumentsHost, BadRequestException, HttpStatus, NotFoundException } from '@nestjs/common';
import { GlobalExceptionFilter } from './http-exception.filter';
import { PayFlowException } from '../exceptions/payflow.exception';

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  let mockResponse: any;
  let mockRequest: any;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    mockRequest = {
      url: '/api/v1/test',
      method: 'POST',
      headers: {
        'x-request-id': 'test-request-id-123',
      },
    };
    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as unknown as ArgumentsHost;
  });

  it('should be defined', () => {
    expect(filter).toBeDefined();
  });

  it('should handle PayFlowException with custom code, message, and details', () => {
    const exception = new PayFlowException(
      'INVALID_STATE_TRANSITION',
      'Cannot transition payment from SUCCEEDED to CANCELLED',
      HttpStatus.CONFLICT,
      { currentStatus: 'SUCCEEDED', targetStatus: 'CANCELLED' },
    );

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.CONFLICT,
        code: 'INVALID_STATE_TRANSITION',
        message: 'Cannot transition payment from SUCCEEDED to CANCELLED',
        details: { currentStatus: 'SUCCEEDED', targetStatus: 'CANCELLED' },
        requestId: 'test-request-id-123',
        path: '/api/v1/test',
      }),
    );
  });

  it('should handle standard HttpException and infer machine-readable code', () => {
    const exception = new NotFoundException('Payment not found');

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.NOT_FOUND,
        code: 'NOT_FOUND',
        message: 'Payment not found',
        requestId: 'test-request-id-123',
      }),
    );
  });

  it('should handle BadRequestException validation array messages properly', () => {
    const exception = new BadRequestException(['email must be an email', 'amount must be positive']);

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'BAD_REQUEST',
        message: ['email must be an email', 'amount must be positive'],
      }),
    );
  });

  it('should safely handle unhandled generic Error without leaking sensitive details to client', () => {
    const error = new Error('Database password failed or connection lost');

    filter.catch(error, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error',
        error: 'Internal Server Error',
        requestId: 'test-request-id-123',
      }),
    );
  });

  it('should generate a UUID if x-request-id is not provided in headers', () => {
    mockRequest.headers = {};
    const exception = new NotFoundException('Resource missing');

    filter.catch(exception, mockHost);

    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.any(String),
      }),
    );
  });
});
