import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class UploadAttachmentDto {
  @ApiProperty({
    description:
      '`file_purpose` **code** - `cv`, `photo`, `certificate` or `evidence`. The ' +
      'code rather than the id, so the client can upload without having resolved ' +
      'the dictionary first; the schema’s `attachments[]` carries both.',
    example: 'cv',
  })
  @IsString()
  @MaxLength(40)
  purpose!: string;

  @ApiProperty({
    type: 'string',
    format: 'binary',
    description:
      'Validated against its actual content, not its name: extension, declared MIME ' +
      'type and magic bytes must agree (§12.5).',
  })
  file!: unknown;
}

export class AttachmentDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'cv' }) purposeCode!: string;
  @ApiProperty() fileName!: string;
  @ApiProperty() mimeType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty() createdAt!: string;

  @ApiProperty({
    description:
      'Path on this API. Bytes are proxied after an ownership check - a storage URL ' +
      'would carry the bot token and could never reach a client (ARCHITECTURE.md §9).',
    example: '/files/6f1c…/content',
  })
  downloadPath!: string;
}

export class AttachmentListDto {
  @ApiProperty({ type: [AttachmentDto] })
  items!: AttachmentDto[];
}
