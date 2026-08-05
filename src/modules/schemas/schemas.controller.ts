import {
  Controller,
  Get,
  Header,
  HttpStatus,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { XLang } from '@infra/api/decorators/x-lang.decorator';
import type { LocaleCode } from '@infra/db/database.types';

import { FieldSchemaDto, SchemaQueryDto } from './dto/schemas.dto';
import { SchemasService } from './schemas.service';

/**
 * Category-driven form definitions (§5.2, docs/API_CONTRACTS.md §4).
 *
 * Why the client fetches its form instead of shipping it: §5.2 requires the
 * profile to adapt to the occupation category and "irrelevant fields shall not be
 * mandatory". Hardcoding five variants per screen means a field set can only
 * change with an app release - and the server validates writes against this same
 * declaration, so a client that had it wrong would produce clean 422s it could
 * not explain.
 */
@ApiTags('schemas')
@ApiBearerAuth()
@ApiHeader({
  name: 'x-lang',
  required: false,
  description:
    'Locale for every `label` in the response. Canonical form is echoed back.',
})
@Controller('schemas')
export class SchemasController {
  constructor(private readonly schemas: SchemasService) {}

  @Get('candidate-profile')
  @ApiOperation({
    summary: 'The candidate profile form for one work category',
    description:
      'Core and category sections together, so every code in ' +
      '`requiredForSearchable` resolves to a field the client can focus. ' +
      'Attachments are outside the field union (§4.5) and carry their own rules.',
  })
  @ApiOkResponse({ type: FieldSchemaDto })
  @ApiResponse({
    status: HttpStatus.NOT_MODIFIED,
    description: 'The client’s `If-None-Match` matches the current version.',
  })
  @Header('Vary', 'x-lang')
  @Header('Cache-Control', 'private, max-age=0, must-revalidate')
  async candidateProfile(
    @Query() query: SchemaQueryDto,
    @XLang() locale: LocaleCode,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<FieldSchemaDto | undefined> {
    const version = await this.schemas.version(
      'candidate_profile',
      query.category,
    );
    // Category and locale both change the body, so both are in the tag.
    const etag = `W/"schema:candidate-profile:${query.category}:${version}:${locale}"`;

    response.setHeader('ETag', etag);

    if (request.headers['if-none-match'] === etag) {
      response.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }

    return this.schemas.fieldSchema(
      'candidate_profile',
      query.category,
      locale,
    );
  }

  @Get('vacancy')
  @ApiOperation({
    summary: 'The vacancy form for one work category',
    description:
      'The same mechanism as the candidate profile, deliberately: the client renders ' +
      'both with one form engine, and the server validates both against these ' +
      'declarations. `requiredForSearchable` here means "required before the vacancy ' +
      'may be submitted for publication".',
  })
  @ApiOkResponse({ type: FieldSchemaDto })
  @ApiResponse({
    status: HttpStatus.NOT_MODIFIED,
    description: 'The client’s `If-None-Match` matches the current version.',
  })
  @Header('Vary', 'x-lang')
  @Header('Cache-Control', 'private, max-age=0, must-revalidate')
  async vacancy(
    @Query() query: SchemaQueryDto,
    @XLang() locale: LocaleCode,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<FieldSchemaDto | undefined> {
    const version = await this.schemas.version('vacancy', query.category);
    const etag = `W/"schema:vacancy:${query.category}:${version}:${locale}"`;

    response.setHeader('ETag', etag);

    if (request.headers['if-none-match'] === etag) {
      response.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }

    return this.schemas.fieldSchema('vacancy', query.category, locale);
  }
}
