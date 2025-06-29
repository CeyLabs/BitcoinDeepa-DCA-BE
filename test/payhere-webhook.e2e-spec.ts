import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createHash } from 'crypto';
import { AppModule } from '../src/app.module';
import { KnexService } from '../src/modules/knex/knex.service';
import { BitcoinPriceService } from '../src/modules/bitcoin-price/bitcoin-price.service';

describe('PayHere Webhook (e2e)', () => {
  let app: INestApplication;
  let knexService: KnexService;
  let bitcoinPriceService: BitcoinPriceService;

  // Test data
  const testSubscriptionId = 'test_sub_12345';
  const testPaymentId = 'test_pay_67890';
  const testMerchantId = 'test_merchant';
  const testMerchantSecret = 'test_secret';

  beforeAll(async () => {
    // Set test environment variables
    process.env.PAYHERE_MERCHANT_SECRET = testMerchantSecret;
    process.env.ENABLE_BITCOIN_TRACKING = 'true';
    process.env.NODE_ENV = 'test';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    knexService = moduleFixture.get<KnexService>(KnexService);
    bitcoinPriceService =
      moduleFixture.get<BitcoinPriceService>(BitcoinPriceService);

    await app.init();

    // Run migrations for testing (skip seeds to avoid duplicates)
    await knexService.knex.migrate.latest();

    // Insert required test data
    await knexService
      .knex('package')
      .insert({
        id: '00000000-0000-0000-0000-000000000001',
        name: 'Starter Weekly',
        amount: 2500,
        currency: 'LKR',
        frequency: 'weekly',
      })
      .onConflict('id')
      .ignore();

    await knexService
      .knex('user')
      .insert({
        id: 'test_user_123',
        first_name: 'Test',
        last_name: 'User',
        address: '123 Test Street',
        city: 'Test City',
        country: 'Test Country',
      })
      .onConflict('id')
      .ignore();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    // Clean up test data before each test (respecting foreign key constraints)
    await knexService
      .knex('transaction')
      .where('payhere_pay_id', 'like', 'test_%')
      .del();
    await knexService
      .knex('subscription')
      .where('payhere_sub_id', 'like', 'test_%')
      .del();

    // Clear Bitcoin price cache
    bitcoinPriceService.clearCache();
  });

  describe('POST /transaction/payhere-webhook', () => {
    it('should process successful payment with Bitcoin calculation', async () => {
      // Mock Bitcoin price service to return predictable data
      const mockBitcoinData = {
        satoshis: 50000,
        btc_price: 50000,
        currency: 'LKR',
        timestamp: new Date(),
      };

      jest
        .spyOn(bitcoinPriceService, 'calculateSatoshis')
        .mockResolvedValue(mockBitcoinData);

      // Create test subscription
      await knexService.knex('subscription').insert({
        payhere_sub_id: testSubscriptionId,
        user_id: 'test_user_123',
        package_id: '00000000-0000-0000-0000-000000000001', // Use valid package ID from seed data
        is_active: true,
      });

      const webhookData = {
        merchant_id: testMerchantId,
        order_id: 'order_123',
        payment_id: testPaymentId,
        subscription_id: testSubscriptionId,
        payhere_amount: '2500.00',
        payhere_currency: 'LKR',
        status_code: '2', // SUCCESS
        md5sig: '', // Will be calculated below
      };

      // Calculate proper MD5 signature
      const signatureString =
        webhookData.merchant_id +
        webhookData.order_id +
        webhookData.payhere_amount +
        webhookData.payhere_currency +
        webhookData.status_code +
        createHash('md5')
          .update(testMerchantSecret)
          .digest('hex')
          .toUpperCase();

      webhookData.md5sig = createHash('md5')
        .update(signatureString)
        .digest('hex')
        .toUpperCase();

      const response = await request(app.getHttpServer())
        .post('/transaction/payhere-webhook')
        .send(webhookData)
        .expect(200);

      expect(response.text).toBe('OK');

      // Verify transaction was created with Bitcoin data
      const transaction = await knexService
        .knex('transaction')
        .where('payhere_pay_id', testPaymentId)
        .first();

      expect(transaction).toBeDefined();
      expect(transaction.status).toBe('SUCCESS');
      expect(transaction.payhere_sub_id).toBe(testSubscriptionId);
      expect(parseFloat(transaction.btc_price_at_purchase)).toBe(
        mockBitcoinData.btc_price,
      );
      expect(parseInt(transaction.satoshis_purchased)).toBe(
        mockBitcoinData.satoshis,
      );
      expect(transaction.price_currency).toBe(mockBitcoinData.currency);
      expect(transaction.coingecko_timestamp).toBeDefined();
    });

    it('should process failed payment without Bitcoin calculation', async () => {
      // Create test subscription
      await knexService.knex('subscription').insert({
        payhere_sub_id: testSubscriptionId,
        user_id: 'test_user_123',
        package_id: '00000000-0000-0000-0000-000000000001', // Use valid package ID from seed data
        is_active: true,
      });

      const webhookData = {
        merchant_id: testMerchantId,
        order_id: 'order_456',
        payment_id: 'test_pay_failed',
        subscription_id: testSubscriptionId,
        payhere_amount: '2500.00',
        payhere_currency: 'LKR',
        status_code: '-2', // FAILED
        md5sig: '',
      };

      // Calculate MD5 signature
      const signatureString =
        webhookData.merchant_id +
        webhookData.order_id +
        webhookData.payhere_amount +
        webhookData.payhere_currency +
        webhookData.status_code +
        createHash('md5')
          .update(testMerchantSecret)
          .digest('hex')
          .toUpperCase();

      webhookData.md5sig = createHash('md5')
        .update(signatureString)
        .digest('hex')
        .toUpperCase();

      const response = await request(app.getHttpServer())
        .post('/transaction/payhere-webhook')
        .send(webhookData)
        .expect(200);

      expect(response.text).toBe('OK');

      // Verify transaction was created without Bitcoin data
      const transaction = await knexService
        .knex('transaction')
        .where('payhere_pay_id', 'test_pay_failed')
        .first();

      expect(transaction).toBeDefined();
      expect(transaction.status).toBe('FAILED');
      expect(transaction.btc_price_at_purchase).toBeNull();
      expect(transaction.satoshis_purchased).toBeNull();
      expect(transaction.price_currency).toBeNull();
      expect(transaction.coingecko_timestamp).toBeNull();
    });

    it('should update existing transaction when payment status changes', async () => {
      // Create test subscription
      await knexService.knex('subscription').insert({
        payhere_sub_id: testSubscriptionId,
        user_id: 'test_user_123',
        package_id: '00000000-0000-0000-0000-000000000001', // Use valid package ID from seed data
        is_active: true,
      });

      // Create initial pending transaction
      await knexService.knex('transaction').insert({
        payhere_pay_id: testPaymentId,
        payhere_sub_id: testSubscriptionId,
        status: 'PENDING',
      });

      // Mock Bitcoin price service
      const mockBitcoinData = {
        satoshis: 50000,
        btc_price: 50000,
        currency: 'LKR',
        timestamp: new Date(),
      };

      jest
        .spyOn(bitcoinPriceService, 'calculateSatoshis')
        .mockResolvedValue(mockBitcoinData);

      const webhookData = {
        merchant_id: testMerchantId,
        order_id: 'order_update',
        payment_id: testPaymentId,
        subscription_id: testSubscriptionId,
        payhere_amount: '2500.00',
        payhere_currency: 'LKR',
        status_code: '2', // SUCCESS
        md5sig: '',
      };

      // Calculate MD5 signature
      const signatureString =
        webhookData.merchant_id +
        webhookData.order_id +
        webhookData.payhere_amount +
        webhookData.payhere_currency +
        webhookData.status_code +
        createHash('md5')
          .update(testMerchantSecret)
          .digest('hex')
          .toUpperCase();

      webhookData.md5sig = createHash('md5')
        .update(signatureString)
        .digest('hex')
        .toUpperCase();

      const response = await request(app.getHttpServer())
        .post('/transaction/payhere-webhook')
        .send(webhookData)
        .expect(200);

      expect(response.text).toBe('OK');

      // Verify transaction was updated with Bitcoin data
      const transaction = await knexService
        .knex('transaction')
        .where('payhere_pay_id', testPaymentId)
        .first();

      expect(transaction).toBeDefined();
      expect(transaction.status).toBe('SUCCESS');
      expect(parseFloat(transaction.btc_price_at_purchase)).toBe(
        mockBitcoinData.btc_price,
      );
      expect(parseInt(transaction.satoshis_purchased)).toBe(
        mockBitcoinData.satoshis,
      );
    });

    it('should reject webhook with invalid MD5 signature', async () => {
      const webhookData = {
        merchant_id: testMerchantId,
        order_id: 'order_invalid',
        payment_id: 'test_pay_invalid',
        subscription_id: testSubscriptionId,
        payhere_amount: '2500.00',
        payhere_currency: 'LKR',
        status_code: '2',
        md5sig: 'invalid_signature',
      };

      const response = await request(app.getHttpServer())
        .post('/transaction/payhere-webhook')
        .send(webhookData)
        .expect(401);

      expect(response.body.message).toBe('Md5 verification failed');

      // Verify no transaction was created
      const transaction = await knexService
        .knex('transaction')
        .where('payhere_pay_id', 'test_pay_invalid')
        .first();

      expect(transaction).toBeUndefined();
    });

    it('should handle Bitcoin price fetch failure gracefully', async () => {
      // Mock Bitcoin price service to fail
      jest
        .spyOn(bitcoinPriceService, 'calculateSatoshis')
        .mockResolvedValue(null);

      // Create test subscription
      await knexService.knex('subscription').insert({
        payhere_sub_id: testSubscriptionId,
        user_id: 'test_user_123',
        package_id: '00000000-0000-0000-0000-000000000001', // Use valid package ID from seed data
        is_active: true,
      });

      const webhookData = {
        merchant_id: testMerchantId,
        order_id: 'order_btc_fail',
        payment_id: 'test_pay_btc_fail',
        subscription_id: testSubscriptionId,
        payhere_amount: '2500.00',
        payhere_currency: 'LKR',
        status_code: '2', // SUCCESS
        md5sig: '',
      };

      // Calculate MD5 signature
      const signatureString =
        webhookData.merchant_id +
        webhookData.order_id +
        webhookData.payhere_amount +
        webhookData.payhere_currency +
        webhookData.status_code +
        createHash('md5')
          .update(testMerchantSecret)
          .digest('hex')
          .toUpperCase();

      webhookData.md5sig = createHash('md5')
        .update(signatureString)
        .digest('hex')
        .toUpperCase();

      const response = await request(app.getHttpServer())
        .post('/transaction/payhere-webhook')
        .send(webhookData)
        .expect(200);

      expect(response.text).toBe('OK');

      // Verify transaction was created without Bitcoin data but with SUCCESS status
      const transaction = await knexService
        .knex('transaction')
        .where('payhere_pay_id', 'test_pay_btc_fail')
        .first();

      expect(transaction).toBeDefined();
      expect(transaction.status).toBe('SUCCESS');
      expect(transaction.btc_price_at_purchase).toBeNull();
      expect(transaction.satoshis_purchased).toBeNull();
    });

    it('should respect ENABLE_BITCOIN_TRACKING=false setting', async () => {
      // Temporarily disable Bitcoin tracking
      process.env.ENABLE_BITCOIN_TRACKING = 'false';

      // Create test subscription
      await knexService.knex('subscription').insert({
        payhere_sub_id: testSubscriptionId,
        user_id: 'test_user_123',
        package_id: '00000000-0000-0000-0000-000000000001', // Use valid package ID from seed data
        is_active: true,
      });

      const webhookData = {
        merchant_id: testMerchantId,
        order_id: 'order_no_btc',
        payment_id: 'test_pay_no_btc',
        subscription_id: testSubscriptionId,
        payhere_amount: '2500.00',
        payhere_currency: 'LKR',
        status_code: '2', // SUCCESS
        md5sig: '',
      };

      // Calculate MD5 signature
      const signatureString =
        webhookData.merchant_id +
        webhookData.order_id +
        webhookData.payhere_amount +
        webhookData.payhere_currency +
        webhookData.status_code +
        createHash('md5')
          .update(testMerchantSecret)
          .digest('hex')
          .toUpperCase();

      webhookData.md5sig = createHash('md5')
        .update(signatureString)
        .digest('hex')
        .toUpperCase();

      const response = await request(app.getHttpServer())
        .post('/transaction/payhere-webhook')
        .send(webhookData)
        .expect(200);

      expect(response.text).toBe('OK');

      // Verify transaction was created without Bitcoin data
      const transaction = await knexService
        .knex('transaction')
        .where('payhere_pay_id', 'test_pay_no_btc')
        .first();

      expect(transaction).toBeDefined();
      expect(transaction.status).toBe('SUCCESS');
      expect(transaction.btc_price_at_purchase).toBeNull();
      expect(transaction.satoshis_purchased).toBeNull();

      // Re-enable Bitcoin tracking for other tests
      process.env.ENABLE_BITCOIN_TRACKING = 'true';
    });

    it('should handle all transaction status codes correctly', async () => {
      // Create test subscription
      await knexService.knex('subscription').insert({
        payhere_sub_id: testSubscriptionId,
        user_id: 'test_user_123',
        package_id: '00000000-0000-0000-0000-000000000001', // Use valid package ID from seed data
        is_active: true,
      });

      const statusCodes = [
        { code: '2', expected: 'SUCCESS' },
        { code: '0', expected: 'PENDING' },
        { code: '-1', expected: 'CANCELLED' },
        { code: '-2', expected: 'FAILED' },
        { code: '-3', expected: 'CHARGEBACK' },
        { code: '999', expected: 'FAILED' }, // Unknown status should default to FAILED
      ];

      for (const [index, statusTest] of statusCodes.entries()) {
        const paymentId = `test_pay_status_${index}`;

        const webhookData = {
          merchant_id: testMerchantId,
          order_id: `order_status_${index}`,
          payment_id: paymentId,
          subscription_id: testSubscriptionId,
          payhere_amount: '2500.00',
          payhere_currency: 'LKR',
          status_code: statusTest.code,
          md5sig: '',
        };

        // Calculate MD5 signature
        const signatureString =
          webhookData.merchant_id +
          webhookData.order_id +
          webhookData.payhere_amount +
          webhookData.payhere_currency +
          webhookData.status_code +
          createHash('md5')
            .update(testMerchantSecret)
            .digest('hex')
            .toUpperCase();

        webhookData.md5sig = createHash('md5')
          .update(signatureString)
          .digest('hex')
          .toUpperCase();

        const response = await request(app.getHttpServer())
          .post('/transaction/payhere-webhook')
          .send(webhookData)
          .expect(200);

        expect(response.text).toBe('OK');

        // Verify transaction status
        const transaction = await knexService
          .knex('transaction')
          .where('payhere_pay_id', paymentId)
          .first();

        expect(transaction).toBeDefined();
        expect(transaction.status).toBe(statusTest.expected);
      }
    });
  });
});
