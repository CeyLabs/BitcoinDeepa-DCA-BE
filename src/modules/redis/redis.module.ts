import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { redisStore } from 'cache-manager-ioredis-yet';
import { RedisService } from './redis.service';

@Module({
  imports: [
    CacheModule.registerAsync({
      useFactory: async () => {
        try {
          let redisConfig: any = {
            ttl: parseInt(process.env.REDIS_TTL_DEFAULT || '300') * 1000, // Convert to milliseconds
            retryAttempts: 3,
            retryDelay: 1000,
            maxRetriesPerRequest: 3,
            lazyConnect: true,
            enableReadyCheck: true,
            maxMemoryPolicy: 'allkeys-lru',
          };

          // Parse REDIS_URL if provided, otherwise fall back to individual config values
          if (process.env.REDIS_URL) {
            const url = new URL(process.env.REDIS_URL);
            redisConfig = {
              ...redisConfig,
              host: url.hostname,
              port: parseInt(url.port) || 6379,
              db: parseInt(url.pathname.slice(1)) || 0, // Remove leading slash and parse
            };

            // Add authentication from URL
            if (url.username) {
              redisConfig.username = url.username;
            }
            if (url.password) {
              redisConfig.password = url.password;
            }
          } else {
            // Fallback to individual environment variables
            redisConfig = {
              ...redisConfig,
              host: process.env.REDIS_HOST || 'localhost',
              port: parseInt(process.env.REDIS_PORT || '6379'),
              db: parseInt(process.env.REDIS_DATABASE || '0'),
            };

            // Add authentication if credentials are provided
            if (process.env.REDIS_PASSWORD) {
              redisConfig.password = process.env.REDIS_PASSWORD;
            }
            
            if (process.env.REDIS_USERNAME) {
              redisConfig.username = process.env.REDIS_USERNAME;
            }
          }

          const store = await redisStore(redisConfig);
          
          console.log('Redis store created successfully');
          return {
            store,
            ttl: parseInt(process.env.REDIS_TTL_DEFAULT || '300') * 1000,
          };
        } catch (error) {
          console.error('Failed to create Redis store:', error);
          // Fallback to memory store if Redis is not available
          return {
            ttl: parseInt(process.env.REDIS_TTL_DEFAULT || '300') * 1000,
          };
        }
      },
    }),
  ],
  providers: [RedisService],
  exports: [RedisService, CacheModule],
})
export class RedisModule {}