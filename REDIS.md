# Redis Caching Setup

## Quick Start

### 1. Cloud Redis (Production/Current Setup)
The application is configured to use a cloud Redis instance. No local setup required!

**Current Configuration:**
- URL: `redis://default:password@centerbeam.proxy.rlwy.net:16234/0`
- Authentication: Username/password enabled  
- TTL: 5 minutes default

### 2. Start the Application
```bash
npm run start:dev
```

### 3. Alternative: Local Redis with Docker Compose
For local development without cloud Redis:

```bash
# Start Redis (and PostgreSQL)
docker-compose up -d redis

# Verify Redis is running
docker exec -it bitcoindeepa-redis redis-cli ping
# Should respond with: PONG
```

## Configuration

The application supports both cloud and local Redis setups:

### Cloud Redis (Current Setup)
```bash
# Redis Configuration (Railway/Cloud) - Single URL format
REDIS_URL=redis://default:jMjRTnsjTJAZUjZxLnSxVqylJMDwfOmm@centerbeam.proxy.rlwy.net:16234/0
REDIS_TTL_DEFAULT=300

# Bitcoin Price Cache TTL (seconds)
BITCOIN_PRICE_CACHE_TTL=20
```

### Local Redis (Alternative)
```bash
# Redis Configuration (Local Docker) - Single URL format
REDIS_URL=redis://localhost:6379/0
REDIS_TTL_DEFAULT=300

# Or using individual environment variables (fallback)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_DATABASE=0
REDIS_TTL_DEFAULT=300
```

## Graceful Degradation

The application will work even if Redis is not available:
- ✅ **With Redis**: Full caching enabled, sub-10ms response times
- ⚠️ **Without Redis**: Falls back to database queries, logs warnings

## Cache Performance

| Endpoint | Cache TTL | Expected Hit Rate |
|----------|-----------|-------------------|
| `GET /package` | 1 hour | 95% |
| `GET /subscription/current` | 5 minutes | 90% |
| `GET /transaction/list` | 2 minutes | 85% |
| `GET /transaction/latest` | 1 minute | 90% |
| `GET /transaction/dca-summary` | 5 minutes | 85% |
| Bitcoin Price APIs | 20 seconds | 98% |

## Monitoring

Check cache performance in application logs:
- `Cache HIT` - Data served from Redis
- `Cache MISS` - Data fetched from database and cached
- `Cache DEL` - Cache invalidated due to data changes

## Troubleshooting

### Redis Connection Issues
```bash
# Check if Redis container is running
docker ps | grep redis

# View Redis logs
docker logs bitcoindeepa-redis

# Restart Redis
docker-compose restart redis
```

### Clear Cache Manually
```bash
# Connect to Redis CLI
docker exec -it bitcoindeepa-redis redis-cli

# Clear all cache
FLUSHDB

# View all keys
KEYS *

# View specific pattern
KEYS dca:*
```

## Production Considerations

1. **Persistence**: Redis data persists in `redis_data` volume
2. **Memory**: Monitor Redis memory usage with `INFO memory`
3. **Security**: Add password authentication for production
4. **Clustering**: Consider Redis Cluster for high availability
5. **Monitoring**: Set up Redis monitoring and alerts