// src/main.ts
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // ── Structured Logger ─────────────────────────────────────────────────────
  app.useLogger(app.get(Logger));

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port', 3000);
  const env = configService.get<string>('app.env', 'development');
  const corsOrigins = configService.get<string[]>('app.corsOrigins', ['http://localhost:3001']);

  // ── Security Middleware ───────────────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: env === 'production' ? undefined : false,
      crossOriginEmbedderPolicy: env === 'production',
    }),
  );

  app.enableCors({
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'Idempotency-Key',
      'X-Api-Key',
    ],
    credentials: true,
  });

  app.use(compression());

  // ── Global Prefix & Versioning ────────────────────────────────────────────
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // ── Validation Pipe ───────────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,            // Strip unknown properties
      forbidNonWhitelisted: true, // Reject requests with unknown properties
      transform: true,            // Auto-transform payloads to DTO instances
      transformOptions: { enableImplicitConversion: true },
      stopAtFirstError: false,    // Collect all errors before returning
    }),
  );

  // ── Swagger / OpenAPI ─────────────────────────────────────────────────────
  if (env !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Finance Dashboard API')
      .setDescription(
        `## Finance Dashboard Backend API\n\n` +
        `Role-based access control:\n` +
        `- **VIEWER** – Read-only access to own transactions and dashboard\n` +
        `- **ANALYST** – Read access to all data + insights\n` +
        `- **ADMIN** – Full management access\n\n` +
        `### Seed credentials\n` +
        `| Role | Email | Password |\n` +
        `|------|-------|----------|\n` +
        `| ADMIN | admin@finance.dev | Admin@123 |\n` +
        `| ANALYST | analyst@finance.dev | Analyst@123 |\n` +
        `| VIEWER | viewer@finance.dev | Viewer@123 |`,
      )
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .addTag('Auth', 'Authentication endpoints')
      .addTag('Users', 'User management (Admin/Analyst)')
      .addTag('Transactions', 'Financial record management')
      .addTag('Dashboard', 'Analytics and summary data')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
      },
    });
  }

  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`🚀 Application running on: http://localhost:${port}/api/v1`);
  logger.log(`📚 Swagger docs at:        http://localhost:${port}/api/docs`);
  logger.log(`🌍 Environment:             ${env}`);
}

bootstrap().catch((err) => {
  console.error('Failed to start application:', err);
  process.exit(1);
});
