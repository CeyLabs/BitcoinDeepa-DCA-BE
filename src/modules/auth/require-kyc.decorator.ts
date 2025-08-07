import { SetMetadata } from '@nestjs/common';

export const RequireKyc = () => SetMetadata('requireKyc', true);
