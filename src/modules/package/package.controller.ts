import { Controller, Get } from '@nestjs/common';
import { PackageService, Package } from './package.service';

@Controller('package')
export class PackageController {
  constructor(private readonly packageService: PackageService) {}

  @Get()
  async getAllPackages(): Promise<Package[]> {
    return this.packageService.getAllPackages();
  }
}
