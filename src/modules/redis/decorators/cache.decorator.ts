import { SetMetadata } from '@nestjs/common';

export const CACHE_KEY_METADATA = 'cache:key';
export const CACHE_TTL_METADATA = 'cache:ttl';

export interface CacheOptions {
  key?: string;
  ttl?: number;
  keyGenerator?: (...args: any[]) => string;
}

/**
 * Decorator to cache method results
 * @param options Cache configuration options
 */
export const Cacheable = (options: CacheOptions = {}) => {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    SetMetadata(CACHE_KEY_METADATA, options.key || propertyKey)(target, propertyKey, descriptor);
    SetMetadata(CACHE_TTL_METADATA, options.ttl || 300)(target, propertyKey, descriptor);
    
    if (options.keyGenerator) {
      SetMetadata('cache:keyGenerator', options.keyGenerator)(target, propertyKey, descriptor);
    }
    
    return descriptor;
  };
};

/**
 * Decorator to invalidate cache after method execution
 * @param patterns Array of cache key patterns to invalidate
 */
export const CacheEvict = (patterns: string[] | ((result: any, ...args: any[]) => string[])) => {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    SetMetadata('cache:evict', patterns)(target, propertyKey, descriptor);
    return descriptor;
  };
};