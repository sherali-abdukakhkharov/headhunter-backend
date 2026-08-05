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
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import {
  ActiveUser,
  type CurrentUser,
} from '@infra/api/decorators/current-user.decorator';
import { RateLimit } from '@infra/api/decorators/rate-limit.decorator';
import { RequireRole } from '@infra/api/decorators/require-role.decorator';
import { BadRequestError } from '@infra/api/exceptions/localized.exception';
import { formatWithOffset } from '@infra/time/format';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '@infra/env-schema';

import { AttachmentsService } from './attachments.service';
import {
  AttachmentDto,
  AttachmentListDto,
  UploadAttachmentDto,
} from './dto/attachments.dto';
import {
  EducationDto,
  EducationInputDto,
  EducationListDto,
  ExperienceDto,
  ExperienceInputDto,
  ExperienceListDto,
} from './dto/history.dto';
import { HistoryService } from './history.service';

/**
 * The repeating and file-shaped parts of the candidate profile (§5.1, §5.4).
 *
 * Separate from `CandidatesController` because these are the sections the field
 * engine hands to a bespoke editor (API_CONTRACTS.md §4.1): their sub-resource paths
 * are published in the schema's `endpoint`, and their shapes are fixed rather than
 * schema-driven.
 */
@ApiTags('candidates')
@ApiBearerAuth()
@RequireRole('candidate')
@Controller('candidates/me')
export class HistoryController {
  private readonly timeZone: string;

  constructor(
    private readonly history: HistoryService,
    private readonly attachments: AttachmentsService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  // --- experience ----------------------------------------------------------

  @Get('experience')
  @ApiOperation({
    summary: 'Work experience records',
    description:
      'Current roles first, then most recent. Only `roleTitle` and `startedOn` are ' +
      'required: §5.1 asks for a simplified entry for informal or seasonal work, ' +
      'where there is often no employer to name.',
  })
  @ApiOkResponse({ type: ExperienceListDto })
  async listExperience(
    @ActiveUser() user: CurrentUser,
  ): Promise<ExperienceListDto> {
    return { items: await this.history.listExperience(user.id) };
  }

  @Post('experience')
  @ApiOperation({ summary: 'Add a work experience record' })
  @ApiOkResponse({ type: ExperienceDto })
  addExperience(
    @ActiveUser() user: CurrentUser,
    @Body() dto: ExperienceInputDto,
  ): Promise<ExperienceDto> {
    return this.history.addExperience(user.id, dto);
  }

  @Put('experience/:id')
  @ApiOperation({
    summary: 'Replace a work experience record',
    description:
      'A full replacement rather than a patch: the record is small and a bespoke ' +
      'editor submits the whole form, so a partial write would only add a way for ' +
      'the two to disagree.',
  })
  @ApiOkResponse({ type: ExperienceDto })
  updateExperience(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExperienceInputDto,
  ): Promise<ExperienceDto> {
    return this.history.updateExperience(user.id, id, dto);
  }

  @Delete('experience/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a work experience record' })
  @ApiNoContentResponse()
  removeExperience(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.history.removeExperience(user.id, id);
  }

  // --- education -----------------------------------------------------------

  @Get('education')
  @ApiOperation({
    summary: 'Education records',
    description:
      'Optional for the work categories where §5.1 says it is not relevant - which ' +
      'is why no category makes it required for searchability.',
  })
  @ApiOkResponse({ type: EducationListDto })
  async listEducation(
    @ActiveUser() user: CurrentUser,
  ): Promise<EducationListDto> {
    return { items: await this.history.listEducation(user.id) };
  }

  @Post('education')
  @ApiOperation({ summary: 'Add an education record' })
  @ApiOkResponse({ type: EducationDto })
  addEducation(
    @ActiveUser() user: CurrentUser,
    @Body() dto: EducationInputDto,
  ): Promise<EducationDto> {
    return this.history.addEducation(user.id, dto);
  }

  @Put('education/:id')
  @ApiOperation({ summary: 'Replace an education record' })
  @ApiOkResponse({ type: EducationDto })
  updateEducation(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EducationInputDto,
  ): Promise<EducationDto> {
    return this.history.updateEducation(user.id, id, dto);
  }

  @Delete('education/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an education record' })
  @ApiNoContentResponse()
  removeEducation(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.history.removeEducation(user.id, id);
  }

  // --- attachments ---------------------------------------------------------

  @Get('attachments')
  @ApiOperation({
    summary: 'Files attached to the profile',
    description:
      'CV, photo, certificates and evidence, newest first. `downloadPath` is a path ' +
      'on this API - there is no storage URL to leak (§11.1).',
  })
  @ApiOkResponse({ type: AttachmentListDto })
  async listAttachments(
    @ActiveUser() user: CurrentUser,
  ): Promise<AttachmentListDto> {
    const items = await this.attachments.list(user.id);

    return {
      items: items.map((item) => ({
        ...item,
        createdAt: formatWithOffset(item.createdAt, this.timeZone),
      })),
    };
  }

  @Post('attachments')
  @RateLimit('files')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadAttachmentDto })
  @ApiOperation({
    summary: 'Upload or replace a profile file',
    description:
      'The purpose must be one the category’s schema declares. Uploading past a ' +
      'purpose’s `maxCount` retires the oldest file of that purpose, which is how ' +
      '§5.4’s "replace" works: the new file is stored first, so a failed upload ' +
      'never leaves the candidate without a CV.',
  })
  @ApiOkResponse({ type: AttachmentDto })
  async uploadAttachment(
    @ActiveUser() user: CurrentUser,
    @Body() dto: UploadAttachmentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<AttachmentDto> {
    if (!file) {
      throw new BadRequestError('file.missing');
    }

    const stored = await this.attachments.upload(user.id, dto.purpose, {
      bytes: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
    });

    return {
      ...stored,
      createdAt: formatWithOffset(stored.createdAt, this.timeZone),
    };
  }

  @Delete('attachments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a profile file',
    description:
      'The metadata row is marked deleted, which is what makes the bytes ' +
      'unreachable. Nothing is purged: BR-14’s retention period is still open.',
  })
  @ApiNoContentResponse()
  removeAttachment(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.attachments.remove(user.id, id);
  }
}
