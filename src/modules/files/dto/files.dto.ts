import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UploadFileDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description:
      'The file itself. PDF, DOC, DOCX for a CV; PDF, JPG, PNG for ' +
      'certificates and evidence. The server checks the content, not just the ' +
      'extension.',
  })
  file!: unknown;

  @ApiProperty({
    example: 'cv',
    description:
      'A `file_purpose` dictionary code: cv, certificate or evidence. Codes ' +
      'come from `GET /dictionaries/file_purpose`, so a new evidence type needs ' +
      'no client release (docs/API_CONTRACTS.md §4.5).',
  })
  @IsString()
  @MaxLength(60)
  purpose!: string;
}

export class StoredFileResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    description:
      'The `file_purpose` dictionary item this file was uploaded against.',
  })
  purposeId!: string;

  @ApiProperty({ example: 'cv.pdf' })
  fileName!: string;

  @ApiProperty({ example: 'application/pdf' })
  mimeType!: string;

  @ApiProperty({ example: 184320 })
  sizeBytes!: number;

  @ApiProperty({ example: '2026-08-12T14:00:00+05:00' })
  createdAt!: string;

  @ApiProperty({
    example: '/files/9f1c…/content',
    description:
      'Path to fetch the bytes from **this** API. There is no direct storage ' +
      'URL and there never will be: the underlying link carries a bot token and ' +
      'expires within the hour, and §11.1 forbids permanently public links.',
  })
  downloadPath!: string;
}

export class FileListResponseDto {
  @ApiProperty({ type: StoredFileResponseDto, isArray: true })
  files!: StoredFileResponseDto[];
}

export class ListFilesQueryDto {
  @ApiPropertyOptional({
    example: 'cv',
    description: 'Restrict to one `file_purpose` code.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  purpose?: string;
}
