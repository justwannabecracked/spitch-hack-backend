import { Test, TestingModule } from '@nestjs/testing';
import { AkawoController } from './akawo.controller';

describe('AkawoController', () => {
  let controller: AkawoController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AkawoController],
    }).compile();

    controller = module.get<AkawoController>(AkawoController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
