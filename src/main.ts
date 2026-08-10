import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import {
  ValidationFailedException,
  toViolations,
} from './infra/api/exceptions/validation-failed.exception';
import { ApiExceptionFilter } from './infra/api/filters/api-exception.filter';
import { buildOpenApiDocument } from './infra/api/openapi';
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
  const clientIpHeader = config.get('CLIENT_IP_HEADER', { infer: true });
  const docsEnabled = config.get('API_DOCS_ENABLED', { infer: true });
  const publicBaseUrl = config.get('PUBLIC_BASE_URL', { infer: true });

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
      // §3.2 requires localized validation messages, and this factory cannot see
      // the request. It emits structured violations instead; ApiExceptionFilter
      // renders them once the locale is known.
      exceptionFactory: (errors) =>
        new ValidationFailedException(toViolations(errors)),
    }),
  );

  // Every error body in the product is produced here: localized message, stable
  // machine-readable code, `Retry-After` where there is one, and nothing
  // internal on an unexpected failure.
  app.useGlobalFilters(new ApiExceptionFilter());

  if (docsEnabled) {
    // Built by the same function `pnpm docs:openapi` exports, so the served
    // description and the delivered file cannot drift (§13.2).
    const swaggerDoc = buildOpenApiDocument(app);

    SwaggerModule.setup('docs', app, swaggerDoc);
    app.use('/reference', apiReference({ content: swaggerDoc }));
  }

  // Lets onApplicationShutdown hooks (e.g. closing the pg pool) actually run.
  app.enableShutdownHooks();

  await app.listen(port);

  const logger = app.get(Logger);
  const base = publicBaseUrl || `http://localhost:${port}`;

  logger.log(`Headhunter API listening on ${base}`);

  if (docsEnabled) {
    logger.log(`Swagger UI:       ${base}/docs`);
    logger.log(`Scalar reference: ${base}/reference`);
  } else {
    logger.log('API docs are disabled (API_DOCS_ENABLED=false)');
  }

  if (clientIpHeader) {
    logger.log(`Client IP read from the ${clientIpHeader} header`);
  } else if (proxyHops > 0) {
    // The combination that silently breaks per-IP limits: proxy-aware Express, but
    // nothing telling us where the caller's address actually is. Every request then
    // keys off the proxy's address and the whole world shares one bucket.
    logger.warn(
      `TRUSTED_PROXY_HOPS is ${proxyHops} but CLIENT_IP_HEADER is empty, so ` +
        'per-IP rate limits will key off the proxy address rather than the ' +
        'caller. Behind a Cloudflare tunnel set CLIENT_IP_HEADER=cf-connecting-ip.',
    );
  }
}

void bootstrap();
