import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/** The bot's transfer ids: p2p-<hex> */
@Injectable()
export class TransferIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!/^p2p-[0-9a-f]{1,60}$/.test(value)) {
      throw new BadRequestException('Invalid transfer id');
    }
    return value;
  }
}
