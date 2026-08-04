import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '@infra/api/decorators/public.decorator';

import { HealthResponseDto } from './dto/health-response.dto';
import { HealthService } from './health.service';

// Monitoring cannot hold a token, and AuthorizationGuard is global.
@Public()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Liveness and dependency check',
    description:
      'Always returns 200 when the process is serving. Inspect the ' +
      '`status` and `database` fields to tell healthy from degraded.',
  })
  @ApiOkResponse({ type: HealthResponseDto })
  check(): Promise<HealthResponseDto> {
    return this.healthService.check();
  }
}
