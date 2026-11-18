import { Logger } from '@nestjs/common';

// Keep test output readable: Nest loggers are silenced unless TEST_LOGS=1.
if (process.env.TEST_LOGS !== '1') {
  Logger.overrideLogger(false);
}
