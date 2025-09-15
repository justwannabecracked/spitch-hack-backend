import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MulterModule } from '@nestjs/platform-express';
import { AkawoController } from './akawo.controller';
import { AkawoService } from './akawo.service';
import { Transaction, TransactionSchema } from './schemas/transaction.schema';
import { multerConfig } from '../config/multer-config';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transaction.name, schema: TransactionSchema },
    ]),
    MulterModule.register(multerConfig),
  ],
  controllers: [AkawoController],
  providers: [AkawoService],
})
export class AkawoModule {}
