# BitcoinDeepa DCA Telegram Mini App Backend

A NestJS backend service for the BitcoinDeepa DCA (Dollar Cost Averaging) Telegram Mini App, providing subscription management, payment integration, and user management with Telegram authentication.

## 🚀 Features

- **Telegram Mini App Authentication**: Secure JWT-based authentication using Telegram's init data
- **Subscription Management**: Create, manage, and cancel user subscriptions
- **Package System**: Handle different subscription packages
- **PayHere Payment Integration**: Recurring payments, webhook, and subscription cancellation
- **Transaction Tracking**: Webhook for payment notifications and user transaction history
- **User Management**: Create and manage user profiles
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
- PayHere Merchant credentials (see below)
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
  "initData": "<initDataStringFromTelegram>"
}
```

### User Management

#### POST /user
Create a new user profile (requires authentication).

**Headers:**
```
Authorization: Bearer <jwt_token>
```
**Request:**
```json
{
  "first_name": "Alice",
  "last_name": "Smith",
  "email": "alice@example.com",
  "phone": "1234567890",
  "address": "123 Main St",
  "city": "Colombo",
  "country": "Sri Lanka"
}
```
**Response:**
- 201 Created (empty body)

### Packages

#### GET /package
Get all available packages.

### Subscriptions

#### GET /subscription/current
Get the current subscription for the authenticated user.

**Headers:**
```
Authorization: Bearer <jwt_token>
```

#### POST /subscription/payhere-link
Get a PayHere payment link for a package.

**Headers:**
```
Authorization: Bearer <jwt_token>
```
**Request:**
```json
{
  "package_id": "<uuid>"
}
```

#### POST /subscription/cancel
Cancel the current user's active subscription (PayHere API integration).

**Headers:**
```
Authorization: Bearer <jwt_token>
```

### Transactions & PayHere Webhook

#### POST /transaction/payhere-webhook
PayHere will POST payment notifications to this endpoint 

#### GET /transaction/list
List all transactions for the current authenticated user.

**Headers:**
```
Authorization: Bearer <jwt_token>
```

## 💳 PayHere Integration

- **Recurring Payments:** Generates PayHere payment links for subscriptions.
- **Webhook:** Handles payment notifications and updates transaction status.
- **Cancel Subscription:** Cancels PayHere subscriptions and updates local DB.
- **OAuth:** Uses PayHere OAuth for secure API access.

## 🗂️ Project Structure

- `src/modules/user` - User management
- `src/modules/package` - Subscription packages
- `src/modules/subscription` - Subscription logic and PayHere integration
- `src/modules/transaction` - Payment notifications and transaction history
- `src/modules/payhere` - PayHere API helpers

## 📝 Notes
- Ensure your PayHere notify_url is public and points to `/transaction/payhere-webhook`.
- The backend expects all PayHere secrets and IDs to be set in your environment.
- All endpoints (except webhook) require JWT authentication.

---

For more details, see the code and comments in each module.
