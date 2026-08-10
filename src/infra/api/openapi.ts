import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';

/**
 * The OpenAPI document, built in one place.
 *
 * §13.2 asks for a "current API description" as a deliverable, and the running service
 * serves one at `/docs`. Those two must not be able to disagree, so the description is
 * built here and used by both `main.ts` and `export-openapi.ts` - a second
 * `DocumentBuilder` would be a second contract.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Headhunter API')
      .setDescription('Job search and recruitment backend')
      .setVersion('0.0.1')
      .addBearerAuth()
      .build(),
  );
}
