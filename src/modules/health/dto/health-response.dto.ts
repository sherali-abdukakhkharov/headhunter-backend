import { ApiProperty } from '@nestjs/swagger';

/**
 * Response shape of `GET /health`.
 *
 * The Flutter client mirrors this in
 * `lib/src/features/health/domain/health_status.dart` - change both together.
 */
export class HealthResponseDto {
  @ApiProperty({
    enum: ['ok', 'degraded'],
    description:
      'Overall service state. `degraded` means the API is serving but at ' +
      'least one dependency is unhealthy.',
    example: 'ok',
  })
  status!: 'ok' | 'degraded';

  @ApiProperty({
    enum: ['up', 'down'],
    description: 'PostgreSQL connectivity.',
    example: 'up',
  })
  database!: 'up' | 'down';

  @ApiProperty({
    description: 'Backend application version.',
    example: '0.0.1',
  })
  version!: string;

  @ApiProperty({
    description:
      'When this response was produced. ISO-8601 with an explicit numeric ' +
      'offset, never `Z` (docs/API_CONTRACTS.md §2).',
    example: '2026-08-04T15:00:00+05:00',
  })
  timestamp!: string;
}
