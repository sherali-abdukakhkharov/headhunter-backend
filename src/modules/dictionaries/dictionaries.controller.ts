import {
  Controller,
  Get,
  Header,
  HttpStatus,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Public } from '@infra/api/decorators/public.decorator';
import { XLang } from '@infra/api/decorators/x-lang.decorator';
import type { LocaleCode } from '@infra/db/database.types';

import { DictionariesService } from './dictionaries.service';
import {
  DeltaQueryDto,
  DictionaryDeltaDto,
  DictionaryItemsDto,
  DictionaryManifestDto,
  ItemsQueryDto,
} from './dto/dictionaries.dto';

/**
 * Dictionary reads (§3.2, §3.3, BR-13).
 *
 * Public: the language and the pickers behind it are chosen **before**
 * registration (§3.2, §4.1), so requiring a token here would make the first
 * screen of the app impossible.
 */
@ApiTags('dictionaries')
@ApiHeader({
  name: 'x-lang',
  required: false,
  description:
    'uz-Latn | uz-Cyrl | ru | en. The aliases `uz` and `oz` are accepted; the ' +
    'response always echoes the canonical form. Unknown values fall back to ' +
    'uz-Latn rather than failing the request.',
})
@Public()
@Controller('dictionaries')
export class DictionariesController {
  constructor(private readonly dictionaries: DictionariesService) {}

  @Get('manifest')
  @ApiOperation({
    summary: 'Per-type and field-schema versions',
    description:
      'One request tells a cold client exactly what it needs to refetch. ' +
      'Locale-independent, so it is safe to cache across a language change.',
  })
  @ApiOkResponse({ type: DictionaryManifestDto })
  // Locale-independent, so `Vary: x-lang` would only fragment the cache.
  @Header('Cache-Control', 'private, max-age=0, must-revalidate')
  manifest(): Promise<DictionaryManifestDto> {
    return this.dictionaries.manifest();
  }

  @Get('items')
  @ApiOperation({
    summary: 'Resolve specific ids, including inactive and merged ones',
    description:
      'For rendering historical records that reference values the client never ' +
      'cached. Not a picker source - use `GET /dictionaries/{type}` for that.',
  })
  @ApiOkResponse({ type: DictionaryItemsDto })
  @Header('Vary', 'x-lang')
  async items(
    @Query() query: ItemsQueryDto,
    @XLang() locale: LocaleCode,
  ): Promise<DictionaryItemsDto> {
    return {
      locale,
      items: await this.dictionaries.itemsByIds(query.ids, locale),
    };
  }

  @Get(':type')
  @ApiOperation({
    summary: 'Items of one dictionary type, in full or as a delta',
    description:
      'Labels are display-only. Every filter and every write body carries ids ' +
      '(BR-13) - if a label ever needs to travel client → server, the contract ' +
      'is wrong.',
  })
  @ApiParam({
    name: 'type',
    description:
      'occupation | skill | industry | region | language | employment_type | ' +
      'work_format | shift | attribute | skill_level | language_level | ' +
      'education_level | payment_period | file_purpose',
  })
  @ApiOkResponse({ type: DictionaryDeltaDto })
  @ApiResponse({
    status: HttpStatus.NOT_MODIFIED,
    description: 'The client’s `If-None-Match` matches the current version.',
  })
  @Header('Vary', 'x-lang')
  @Header('Cache-Control', 'private, max-age=0, must-revalidate')
  async byType(
    @Param('type') type: string,
    @Query() query: DeltaQueryDto,
    @XLang() locale: LocaleCode,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DictionaryDeltaDto | undefined> {
    const known = await this.dictionaries.listTypes();

    // An unknown type is a 404 rather than an empty set: a client that
    // misspelled a type must find out, not silently render no options.
    if (!known.includes(type)) {
      throw new NotFoundException(`Unknown dictionary type: ${type}`);
    }

    const version = await this.dictionaries.typeVersion(type);
    // The locale is part of the tag because the payload's labels are: two
    // locales at the same version are different bodies.
    const etag = `W/"${type}:${version}:${locale}"`;

    response.setHeader('ETag', etag);

    if (request.headers['if-none-match'] === etag) {
      // A 304 must carry no body, and returning undefined with `passthrough`
      // sends none. This is the common case in steady state - the whole point of
      // the manifest is that most revalidations end here.
      response.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }

    return this.dictionaries.delta(type, locale, query.since ?? null);
  }
}
