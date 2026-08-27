import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { RateLimit } from '@infra/api/decorators/rate-limit.decorator';
import {
  ActiveUser,
  type CurrentUser,
} from '@infra/api/decorators/current-user.decorator';
import { BadRequestError } from '@infra/api/exceptions/localized.exception';
import type { AppEnv } from '@infra/env-schema';
import { type StoredFile, FilesService } from '@infra/files/files.service';
import { formatWithOffset } from '@infra/time/format';

import {
  FileListResponseDto,
  ListFilesQueryDto,
  StoredFileResponseDto,
  UploadFileDto,
} from './dto/files.dto';

/**
 * The caller's own files (§5.4).
 *
 * Everything here is owner-scoped. Employer access to a candidate's CV is BR-09's
 * decision and belongs with the candidate profile (M3); it will reuse
 * `FilesService`, not a second copy of this controller.
 */
@ApiTags('files')
@ApiBearerAuth()
@Controller('files')
export class FilesController {
  private readonly timeZone: string;

  constructor(
    private readonly files: FilesService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  @Post()
  @RateLimit('files')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadFileDto })
  @ApiOperation({
    summary: 'Upload a file',
    description:
      'Type and size are validated against the file’s actual content, not its ' +
      'name. The response carries a path on this API, never a storage URL.',
  })
  @ApiOkResponse({ type: StoredFileResponseDto })
  async upload(
    @ActiveUser() user: CurrentUser,
    @Body() dto: UploadFileDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<StoredFileResponseDto> {
    if (!file) {
      throw new BadRequestError('file.missing');
    }

    const stored = await this.files.store(user.id, dto.purpose, {
      bytes: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
    });

    return this.toDto(stored);
  }

  @Get()
  @ApiOperation({ summary: 'List the caller’s files' })
  @ApiOkResponse({ type: FileListResponseDto })
  async list(
    @ActiveUser() user: CurrentUser,
    @Query() query: ListFilesQueryDto,
  ): Promise<FileListResponseDto> {
    const files = await this.files.listForOwner(user.id, query.purpose);

    return { files: files.map((file) => this.toDto(file)) };
  }

  @Get(':id/content')
  @RateLimit('files')
  @ApiOperation({
    summary: 'Download a file’s bytes',
    description:
      'Streamed through this API after an ownership check. `Content-Disposition` ' +
      'is `attachment` and `X-Content-Type-Options: nosniff` is set, so an ' +
      'uploaded document can never be rendered as a page in the caller’s origin.',
  })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async download(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const { file, bytes } = await this.files.read(user.id, id);

    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', String(bytes.length));
    // `attachment`, and the filename quoted after sanitization in FilesService -
    // a stored name can otherwise inject a header or open in-browser.
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.fileName}"`,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // Never cached by an intermediary: the bytes are private to one account.
    response.setHeader('Cache-Control', 'private, no-store');

    response.end(bytes);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a file',
    description:
      'The metadata row is marked deleted, which is what makes the file ' +
      'unreachable. Nothing is purged: BR-14’s retention period is still open.',
  })
  @ApiNoContentResponse()
  async remove(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.files.softDelete(user.id, id);
  }

  private toDto(file: StoredFile): StoredFileResponseDto {
    return {
      id: file.id,
      purposeId: file.purposeId,
      purposeCode: file.purposeCode,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      createdAt: formatWithOffset(file.createdAt, this.timeZone),
      downloadPath: `/files/${file.id}/content`,
    };
  }
}
