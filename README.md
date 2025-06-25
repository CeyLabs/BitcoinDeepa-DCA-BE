# BitcoinDeepa DCA Telegram Mini App Backend

A NestJS backend service for the BitcoinDeepa DCA (Dollar Cost Averaging) Telegram Mini App, providing subscription management and package handling with Telegram authentication.

## 🚀 Features

- **Telegram Mini App Authentication**: Secure JWT-based authentication using Telegram's init data
- **Subscription Management**: Create and manage user subscriptions
- **Package System**: Handle different subscription packages
- **Database Integration**: PostgreSQL with Knex.js for migrations and seeding
- **TypeScript**: Full type safety throughout the application

## 🛠️ Tech Stack

- **Framework**: NestJS
- **Language**: TypeScript
- **Database**: PostgreSQL
- **ORM**: Knex.js
- **Authentication**: JWT with Telegram Mini App validation

## 📋 Prerequisites

- Node.js v22
- PostgreSQL database
- Telegram Bot Token
- pnpm (recommended)

## 🚀 Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/CeyLabs/BitcoinDeepa-DCA-TMA-BE.git
cd BitcoinDeepa-DCA-TMA-BE
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Environment Setup

Create a `.env` file in the root directory:

```bash
cp .env.template .env
```

### 4. Database Setup

```bash
# Run migrations
pnpm migrate

# Seed the database with initial data
pnpm seed
```

### 5. Start the Application

```bash
# Development mode
pnpm start:dev

# Production mode
pnpm start:prod
```

The server will start on `http://localhost:3000`

## 📚 API Documentation

### Authentication

#### POST /auth/telegram
Validates Telegram Mini App init data and returns a JWT token.

**Request:**
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

### Subscriptions

#### GET /subscription/current
Get the current subscription for the authenticated user.

**Headers:**
```
Authorization: Bearer <jwt_token>
```

**Response:**
```json
{
  "id": "sub_123",
  "user_id": "123456789",
  "package_id": "pkg_456",
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-01T00:00:00Z"
}
```

### Packages

#### GET /package
Get all available packages.

**Response:**
```json
[
  {
    "id": "pkg_456",
    "name": "Basic Plan",
    "price": 9.99,
    "description": "Basic DCA subscription",
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z"
  }
]
```
