# Telegram Mini App Authentication

This project includes a complete authentication system for Telegram Mini Apps using JWT tokens.

## Setup

1. Set the following environment variables:
   ```bash
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token
   JWT_SECRET=your_jwt_secret_key
   ENABLE_AUTH=true  # Set to 'false' to disable authentication (development only)
   ```

## Environment Variables

- `TELEGRAM_BOT_TOKEN`: Your Telegram bot token for validating Mini App init data
- `JWT_SECRET`: Secret key for signing JWT tokens
- `ENABLE_AUTH`: Set to `'false'` to disable authentication guards (useful for development/testing)

## API Endpoints

### POST /auth/telegram

Validates Telegram Mini App init data and returns a JWT token.

**Request Body:**
```json
{
  "initData": "query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A123456789%2C%22first_name%22%3A%22John%22%2C%22last_name%22%3A%22Doe%22%2C%22username%22%3A%22johndoe%22%2C%22language_code%22%3A%22en%22%7D&auth_date=1234567890&hash=abc123..."
}
```

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "telegram_id": "123456789",
    "username": "johndoe"
  }
}
```

## Protecting Endpoints

To protect an endpoint with conditional JWT authentication:

1. Import the required decorators and guards:
   ```typescript
   import { UseGuards } from '@nestjs/common';
   import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
   import { CurrentUser } from '../auth/user.decorator';
   import { JwtPayload } from '../auth/auth.service';
   ```

2. Add the `@UseGuards(ConditionalAuthGuard)` decorator to your endpoint:
   ```typescript
   @Get('protected-endpoint')
   @UseGuards(ConditionalAuthGuard)
   async protectedEndpoint(@CurrentUser() user: JwtPayload) {
     // user.user_id contains the Telegram user ID (or 'dev-user-id' when auth is disabled)
     // user.telegram_id contains the Telegram user ID (or 'dev-telegram-id' when auth is disabled)
     // user.username contains the Telegram username (or 'dev-username' when auth is disabled)
     return { message: 'This is a protected endpoint', user };
   }
   ```

3. When `ENABLE_AUTH=true` (default), include the JWT token in the Authorization header:
   ```
   Authorization: Bearer <your_jwt_token>
   ```

4. When `ENABLE_AUTH=false`, no authentication is required and a mock user is provided.

## Development Mode

For development and testing, you can disable authentication by setting:

```bash
ENABLE_AUTH=false
```

When authentication is disabled:
- No JWT token is required for protected endpoints
- A mock user is automatically provided with:
  - `user_id: 'dev-user-id'`
  - `telegram_id: 'dev-telegram-id'`
  - `username: 'dev-username'`

## Example Usage

### Frontend (Telegram Mini App)

```javascript
// Get init data from Telegram WebApp
const initData = window.Telegram.WebApp.initData;

// Send to your backend
const response = await fetch('/auth/telegram', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ initData }),
});

const { token } = await response.json();

// Store the token for future requests
localStorage.setItem('jwt_token', token);
```

### Making Authenticated Requests

```javascript
const token = localStorage.getItem('jwt_token');

const response = await fetch('/subscription/current', {
  headers: {
    'Authorization': `Bearer ${token}`,
  },
});

const subscription = await response.json();
```

## Security Features

- **Conditional Authentication**: Can be disabled for development/testing
- **HMAC Verification**: The init data is verified using Telegram's HMAC-SHA256 signature
- **JWT Tokens**: Secure JWT tokens with configurable expiration (default: 7 days)
- **Environment Variables**: Sensitive data like bot tokens and JWT secrets are stored in environment variables
- **Type Safety**: Full TypeScript support with proper interfaces and decorators

## Error Handling

The authentication system handles various error scenarios:

- `401 Unauthorized`: Invalid or missing JWT token (when auth is enabled)
- `401 Unauthorized`: Invalid Telegram init data
- `401 Unauthorized`: Missing bot token configuration
- `401 Unauthorized`: Invalid user data format 