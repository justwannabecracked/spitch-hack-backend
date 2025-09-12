import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AkawoService } from './akawo.service';
import { AkawoController } from './akawo.controller';
import { Transaction, TransactionSchema } from './schemas/transaction.schema';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transaction.name, schema: TransactionSchema },
    ]),
    ConfigModule,
  ],
  providers: [AkawoService],
  controllers: [AkawoController],
})
export class AkawoModule {}
