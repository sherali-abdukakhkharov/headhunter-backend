import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { DatabaseModule } from '@infra/db/database.module';
import { type AppEnv, envSchema } from '@infra/env-schema';
import { HealthModule } from '@modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validationSchema: envSchema,
      validationOptions: {
        // Report every bad variable at once rather than one per restart.
        abortEarly: false,
      },
    }),

    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          // Human-readable logs locally; raw JSON in production so log
          // aggregators can parse them.
          transport:
            config.get('NODE_ENV', { infer: true }) === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
          // Health polling would otherwise dominate log volume.
          autoLogging: {
            ignore: (req: { url?: string }) => req.url === '/health',
          },
          redact: ['req.headers.authorization', 'req.headers.cookie'],
        },
      }),
    }),

    DatabaseModule,
    HealthModule,
  ],
})
export class AppModule {}
