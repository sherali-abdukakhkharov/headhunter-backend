import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { RetryAfterFilter } from './infra/api/filters/retry-after.filter';
import type { AppEnv } from './infra/env-schema';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // Route Nest's own logs through pino.
  app.useLogger(app.get(Logger));

  const config = app.get<ConfigService<AppEnv, true>>(ConfigService);
  const port = config.get('HTTP_PORT', { infer: true });
  const corsOrigins = config.get('CORS_ORIGINS', { infer: true });
  const proxyHops = config.get('TRUSTED_PROXY_HOPS', { infer: true });

  // Per-IP rate limiting is only as good as `request.ip`. Behind a proxy every
  // request arrives from the proxy's address, so one bucket would be shared by
  // all users; trusting `X-Forwarded-For` without a proxy in front lets a caller
  // spoof the address instead. Neither is safe to guess, so it is configuration,
  // and the default trusts nothing.
  if (proxyHops > 0) {
    app.set('trust proxy', proxyHops);
  }

  app.use(helmet());

  // The mobile client is not browser-origin-bound, but a web build and local
  // tooling are, so CORS is configurable rather than hardcoded.
  app.enableCors({
    origin: corsOrigins === '*' ? true : corsOrigins.split(','),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Turns the `retryAfterSeconds` carried by a 429 into a `Retry-After` header,
  // wherever in the stack it was thrown.
  app.useGlobalFilters(new RetryAfterFilter());

  const swaggerDoc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Headhunter API')
      .setDescription('Job search and recruitment backend')
      .setVersion('0.0.1')
      .addBearerAuth()
      .build(),
  );

  SwaggerModule.setup('docs', app, swaggerDoc);
  app.use('/reference', apiReference({ content: swaggerDoc }));

  // Lets onApplicationShutdown hooks (e.g. closing the pg pool) actually run.
  app.enableShutdownHooks();

  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`Headhunter API listening on http://localhost:${port}`);
  logger.log(`Swagger UI:       http://localhost:${port}/docs`);
  logger.log(`Scalar reference: http://localhost:${port}/reference`);
}

void bootstrap();
