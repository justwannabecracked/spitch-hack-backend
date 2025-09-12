import { Test, TestingModule } from '@nestjs/testing';
import { AkawoService } from './akawo.service';

describe('AkawoService', () => {
  let service: AkawoService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AkawoService],
    }).compile();

    service = module.get<AkawoService>(AkawoService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
